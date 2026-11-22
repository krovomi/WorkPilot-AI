/**
 * Reading a page at several widths (#383): the breakpoints come from the
 * page's own `@media` conditions, parsed by the main into bounded numbers;
 * the page is then read at common widths and one pixel on each side of each
 * breakpoint, on the chosen device, in the capture's hidden window.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const page = vi.hoisted(() => ({
	widths: [] as number[],
	codes: [] as string[],
	answers: [] as unknown[],
	shown: "http://localhost:5173/pricing",
	options: null as unknown,
	throttling: null as unknown,
}));

vi.mock("../device-capture", () => ({
	NO_THROTTLING: { network: { id: "none" }, cpu: { id: "1x", rate: 1 } },
	withDevicePage: async (
		_device: unknown,
		url: string,
		throttling: unknown,
		options: unknown,
		work: (p: unknown) => Promise<unknown>,
	) => {
		page.options = options;
		page.throttling = throttling;
		return work({ wc: { getURL: () => page.shown }, send: vi.fn(), loadMs: 10, origin: new URL(url).origin });
	},
	emulate: async (_send: unknown, device: { width: number }) => {
		page.widths.push(device.width);
	},
	runProbe: async (_wc: unknown, code: string) => {
		page.codes.push(code);
		const answer = page.answers.shift();
		if (answer === "hang") return new Promise(() => undefined);
		return answer;
	},
	wait: async () => undefined,
	withTimeout: <T>(work: Promise<T>, _ms: number) =>
		Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5))]),
	sameOrigin: (target: string, origin: string) => new URL(target).origin === origin,
}));

import { findDevicePreset } from "../../../shared/constants/device-presets";
import type { DevicePreset } from "../../../shared/types/device-matrix";
import {
	MAX_BREAKPOINTS,
	MEDIA_PROBE,
	SCAN_WIDTHS,
	buildMediaProbe,
	parseBreakpoints,
	scanBreakpoints,
	scanWidths,
} from "../breakpoint-scan";

const desktop = findDevicePreset("desktop-1080p") as DevicePreset;
const report = (width: number, issues: unknown[] = []) => ({ viewportWidth: width, scrollWidth: width, scanned: 10, issues });

describe("parseBreakpoints", () => {
	it("reads min-width, max-width and range conditions, in px, em and rem", () => {
		expect(
			parseBreakpoints([
				"(min-width: 768px)",
				"screen and (max-width:1023.5px)",
				"(min-width: 40em) and (orientation: landscape)",
				"(width >= 90rem)",
				"(600px < width <= 900px)",
				"print",
			]),
		).toEqual([600, 640, 768, 900, 1024, 1440]);
	});

	it("keeps only bounded, unique widths, at most MAX_BREAKPOINTS, from strings only", () => {
		expect(parseBreakpoints(["(min-width: 10px)", "(max-width: 99999px)", 42, "(min-width: 768px)", "(min-width:768px)"])).toEqual([
			768,
		]);
		const many = Array.from({ length: 30 }, (_, index) => `(min-width: ${300 + index * 10}px)`);
		expect(parseBreakpoints(many)).toHaveLength(MAX_BREAKPOINTS);
		expect(parseBreakpoints(null)).toEqual([]);
		expect(parseBreakpoints({ length: 3 })).toEqual([]);
	});
});

describe("scanWidths", () => {
	it("adds one pixel on each side of each breakpoint to the common widths", () => {
		expect(scanWidths([])).toEqual(SCAN_WIDTHS);
		expect(scanWidths([768, 1100])).toEqual([320, 375, 414, 767, 768, 769, 1024, 1099, 1101, 1280, 1440, 1920]);
	});

	it("stays within a window's bounds", () => {
		expect(scanWidths([240, 3840])).toEqual([241, ...SCAN_WIDTHS, 3839]);
	});
});

describe("MEDIA_PROBE", () => {
	it("is built with its bounds and only reads the style sheets", () => {
		expect(buildMediaProbe()).toBe(`${MEDIA_PROBE}({"max":400,"len":300})`);
		expect(MEDIA_PROBE).not.toMatch(/insertRule|deleteRule|appendChild|innerHTML|setAttribute|\.textContent\s*=/);
	});

	it("collects media conditions in depth and skips sheets it may not read", () => {
		const rules = [
			{ media: { mediaText: "(min-width: 768px)" }, cssRules: [{ media: { mediaText: "(max-width: 1200px)" } }] },
			{ styleSheet: { cssRules: [{ media: { mediaText: "(min-width: 40em)" } }] } },
			{ cssRules: null },
		];
		const locked = {
			get cssRules() {
				throw new Error("SecurityError");
			},
		};
		const document = { styleSheets: [{ cssRules: rules }, locked] };
		const run = new Function("document", `return ${MEDIA_PROBE}({ max: 10, len: 12 });`);
		expect(run(document)).toEqual(["(min-width: ", "(max-width: ", "(min-width: "]);
		const capped = new Function("document", `return ${MEDIA_PROBE}({ max: 1, len: 300 });`);
		expect(capped(document)).toEqual(["(min-width: 768px)"]);
	});
});

describe("scanBreakpoints", () => {
	beforeEach(() => {
		page.widths = [];
		page.codes = [];
		page.answers = [];
		page.shown = "http://localhost:5173/pricing";
	});

	it("reads the breakpoints, then the page at each width, and keeps counts only", async () => {
		const widths = scanWidths([768]);
		page.answers = [
			["(min-width: 768px)"],
			...widths.map((width) =>
				width === 767
					? {
							...report(width, [
								{ kind: "horizontal-overflow", count: 2, samples: [{ selector: "nav", x: 0, y: 0, width: 900, height: 40 }] },
							]),
							scrollWidth: 900,
							truncated: true,
						}
					: report(width),
			),
		];
		const scan = await scanBreakpoints(desktop, "http://localhost:5173/pricing", { previewSession: true });
		expect(page.options).toEqual({ previewSession: true });
		expect(page.throttling).toMatchObject({ network: { id: "none" } });
		expect(scan.url).toBe("http://localhost:5173/pricing");
		expect(scan.breakpoints).toEqual([768]);
		expect(page.widths).toEqual(widths);
		expect(scan.steps.map((step) => step.width)).toEqual(widths);
		expect(scan.steps.find((step) => step.width === 767)).toEqual({
			width: 767,
			scrollWidth: 900,
			truncated: true,
			issues: [{ kind: "horizontal-overflow", count: 2 }],
		});
		// The reading of the page is the capture's own, built for this device.
		expect(page.codes[1]).toContain('"touch":false');
	});

	it("leaves out a width the page did not answer, and keeps the asked address when the page left", async () => {
		page.shown = "https://elsewhere.example/";
		page.answers = ["not a list", "hang", null, ...SCAN_WIDTHS.slice(2).map((width) => report(width))];
		const scan = await scanBreakpoints(desktop, "http://localhost:5173/", { previewSession: false });
		expect(scan.breakpoints).toEqual([]);
		expect(scan.url).toBe("http://localhost:5173/");
		expect(scan.steps).toHaveLength(SCAN_WIDTHS.length - 2);
		expect(scan.steps[0].width).toBe(414);
	});
});
