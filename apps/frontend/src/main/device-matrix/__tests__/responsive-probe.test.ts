/**
 * @vitest-environment jsdom
 */
/**
 * The responsive reading of a rendered page (#383): the probe finds the
 * classic bugs in a laid-out DOM, reads only, and stops at its bounds; what
 * the page answers is reshaped and bounded before it leaves the main.
 *
 * jsdom has no layout, so each element carries its box in `data-box`
 * (`left,top,width,height`) and the probe's `getBoundingClientRect` reads it.
 */
import { describe, expect, it } from "vitest";
import {
	MAX_ELEMENTS,
	MAX_SAMPLES,
	MIN_TEXT_PX,
	MIN_TOUCH_TARGET_PX,
	RESPONSIVE_PROBE,
	buildProbe,
	sanitizeReport,
} from "../responsive-probe";

interface ProbeOutput {
	viewportWidth: number;
	scrollWidth: number;
	scanned: number;
	truncated: boolean;
	issues: { kind: string; count: number; samples: { selector: string; width: number }[] }[];
}

function probe(body: string, device = { mobile: true, touch: true }, viewport = 400): ProbeOutput {
	document.body.innerHTML = body;
	Object.defineProperty(window, "innerWidth", { value: viewport, configurable: true });
	Object.defineProperty(document.documentElement, "scrollWidth", { value: viewport + 60, configurable: true });
	window.HTMLElement.prototype.getBoundingClientRect = function box(this: HTMLElement) {
		const [left, top, width, height] = (this.getAttribute("data-box") ?? "0,0,100,20").split(",").map(Number);
		return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top } as DOMRect;
	};
	const before = window.document.body.innerHTML;
	// The page's own script engine runs the probe, as Electron's isolated world does.
	const output = (window as unknown as { eval: (code: string) => unknown }).eval(buildProbe(device)) as ProbeOutput;
	expect(window.document.body.innerHTML).toBe(before); // read-only
	return JSON.parse(JSON.stringify(output)) as ProbeOutput;
}

const kind = (output: ProbeOutput, name: string) => output.issues.find((issue) => issue.kind === name);

describe("RESPONSIVE_PROBE", () => {
	it("is a function expression called only with options written in the main", () => {
		expect(RESPONSIVE_PROBE.startsWith("(function (o)")).toBe(true);
		const call = buildProbe({ mobile: false, touch: true });
		const options = JSON.parse(call.slice(RESPONSIVE_PROBE.length + 1, -1));
		expect(options).toEqual({
			touch: true,
			text: false,
			minTouch: MIN_TOUCH_TARGET_PX,
			minText: MIN_TEXT_PX,
			maxSamples: MAX_SAMPLES,
			maxElements: MAX_ELEMENTS,
		});
	});

	it("counts an element past the edge once, not each of its children", () => {
		const output = probe(
			'<div id="wide" class="row hero extra" data-box="0,0,700,50"><p data-box="0,0,650,20">x</p></div>' +
				'<div data-box="-30,60,100,20"></div>',
		);
		const overflow = kind(output, "horizontal-overflow");
		expect(overflow?.count).toBe(2);
		expect(overflow?.samples[0].selector).toBe("div#wide.row.hero");
		expect(output.scrollWidth).toBe(460);
		expect(output.viewportWidth).toBe(400);
	});

	it("names media wider than the screen apart", () => {
		const output = probe('<img data-box="0,0,800,300"><video data-box="0,0,300,100"></video>');
		expect(kind(output, "overflowing-media")?.count).toBe(1);
		expect(kind(output, "horizontal-overflow")?.count).toBe(0);
	});

	it("does not look inside a container that clips or scrolls its content", () => {
		const output = probe(
			'<div style="overflow-x: auto" data-box="0,0,400,100"><div data-box="0,0,900,100"></div></div>',
		);
		expect(kind(output, "horizontal-overflow")?.count).toBe(0);
	});

	it("skips what is not rendered", () => {
		const output = probe(
			'<div style="display:none" data-box="0,0,900,10"></div><div style="visibility:hidden" data-box="0,0,900,10"></div><div data-box="0,0,0,0"></div>',
		);
		expect(kind(output, "horizontal-overflow")?.count).toBe(0);
	});

	it("flags touch targets under 44 px, not inline links nor anchors without href", () => {
		const output = probe(
			'<button data-box="0,0,30,30">ok</button>' +
				'<a href="/x" style="display:block" data-box="0,40,100,20">link</a>' +
				'<a href="/y" style="display:inline" data-box="0,70,20,10">inline</a>' +
				'<a style="display:block" data-box="0,90,20,10">anchor</a>' +
				'<div role="button" data-box="0,110,20,20"></div>' +
				'<button data-box="0,140,48,48">big</button>',
		);
		expect(kind(output, "small-touch-target")?.count).toBe(3);
	});

	it("checks touch targets only on a touch screen", () => {
		const output = probe('<button data-box="0,0,30,30">ok</button>', { mobile: false, touch: false });
		expect(kind(output, "small-touch-target")?.count).toBe(0);
	});

	it("flags text under 12 px on mobile only, and only where text is", () => {
		const body =
			'<p style="font-size:10px" data-box="0,0,100,12">tiny</p>' +
			'<p style="font-size:10px" data-box="0,20,100,12">   </p>' +
			'<p style="font-size:16px" data-box="0,40,100,20">fine</p>';
		expect(kind(probe(body), "small-text")?.count).toBe(1);
		expect(kind(probe(body, { mobile: false, touch: false }), "small-text")?.count).toBe(0);
	});

	it("keeps at most MAX_SAMPLES examples but the full count", () => {
		const many = Array.from({ length: MAX_SAMPLES + 5 }, (_, i) => `<span data-box="${i},0,900,10"></span>`).join("");
		const overflow = kind(probe(many), "horizontal-overflow");
		expect(overflow?.count).toBe(MAX_SAMPLES + 5);
		expect(overflow?.samples).toHaveLength(MAX_SAMPLES);
	});

	it("reads no more than MAX_ELEMENTS elements and says so", () => {
		const output = probe("<i></i>".repeat(MAX_ELEMENTS + 3));
		expect(output.scanned).toBe(MAX_ELEMENTS);
		expect(output.truncated).toBe(true);
	});
});

describe("sanitizeReport", () => {
	it("refuses what is not a report", () => {
		expect(sanitizeReport(null)).toBeNull();
		expect(sanitizeReport("report")).toBeNull();
	});

	it("keeps known kinds once, bounded and finite, drops empty ones", () => {
		const report = sanitizeReport({
			viewportWidth: 390.4,
			scrollWidth: Number.POSITIVE_INFINITY,
			scanned: -5,
			truncated: "yes",
			issues: [
				null,
				{ kind: "run-this", count: 3, samples: [] },
				{ kind: "small-text", count: 0, samples: [] },
				{
					kind: "horizontal-overflow",
					count: 1,
					samples: [
						{ selector: "div\u0000#a\nb", x: 1e9, y: "1", width: -4, height: 2.6 },
						{ selector: 42 },
						"nope",
						...Array.from({ length: 20 }, () => ({ selector: "p" })),
					],
				},
				{ kind: "horizontal-overflow", count: 99, samples: [] },
				{ kind: "small-touch-target", count: "3", samples: "x" },
				{ kind: "overflowing-media", count: 2 },
			],
		});
		expect(report).toMatchObject({ viewportWidth: 390, scrollWidth: 0, scanned: 0, truncated: false });
		expect(report?.issues.map((issue) => issue.kind)).toEqual(["horizontal-overflow", "overflowing-media"]);
		const overflow = report?.issues[0];
		expect(overflow?.samples[0]).toEqual({ selector: "div#ab", x: 100000, y: 0, width: 0, height: 3 });
		// The count is never below the examples kept.
		expect(overflow?.count).toBe(overflow?.samples.length);
		expect(overflow?.samples.length).toBeLessThanOrEqual(MAX_SAMPLES);
		expect(report?.issues[1]).toEqual({ kind: "overflowing-media", count: 2, samples: [] });
	});

	it("bounds a long selector and reads a report without issues", () => {
		const report = sanitizeReport({ issues: [{ kind: "small-text", count: 1, samples: [{ selector: "a".repeat(500) }] }] });
		expect(report?.issues[0].samples[0].selector).toHaveLength(120);
		expect(sanitizeReport({ truncated: true })).toEqual({
			viewportWidth: 0,
			scrollWidth: 0,
			scanned: 0,
			truncated: true,
			issues: [],
		});
	});
});
