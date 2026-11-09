/**
 * The dynamic scan's conclusions from a page trace, with no browser (#391):
 * only an app on this computer may be opened, the page's answer is bounded
 * data, and each rule reads it the way a keyboard or screen reader would.
 */
import { describe, expect, it } from "vitest";
import { analyseTrace, contrastRatio, parseRgb, sanitizeTrace, validateScanUrl } from "../dynamic-checks";

const stop = (over: Record<string, unknown> = {}) => ({
	tag: "BUTTON",
	label: "Go",
	top: 100,
	left: 10,
	width: 80,
	height: 32,
	outlineVisible: true,
	href: "",
	inDialog: false,
	...over,
});

function trace(over: Record<string, unknown> = {}) {
	return sanitizeTrace(
		{
			lang: "en",
			title: "Shop",
			skipTargetExists: true,
			focus: [stop({ tag: "A", href: "#main", label: "Skip", top: 0 }), stop()],
			samples: [],
			ax: [],
			dialogs: [],
			...over,
		},
		"http://localhost:3000/cart?x=1",
	);
}

const rules = (t: ReturnType<typeof trace>, level: "A" | "AA" | "AAA" = "AA") =>
	analyseTrace(t, level).map((v) => v.ruleId);

describe("validateScanUrl", () => {
	it.each([
		"http://localhost:3000/",
		"https://app.localhost/",
		"http://127.0.0.1:5173/a",
		"http://[::1]:8080/",
	])("opens %s", (url) => {
		expect(validateScanUrl(url)).not.toBeNull();
	});

	it.each([
		"https://example.com/",
		"http://192.168.1.10/",
		"file:///etc/passwd",
		"javascript:alert(1)",
		"http://user:pw@localhost/",
		"http://localhost.evil.com/",
		42,
		"",
	])("refuses %s", (url) => {
		expect(validateScanUrl(url)).toBeNull();
	});
});

describe("analyseTrace", () => {
	it("passes a page with a language, a title, a skip link and visible focus", () => {
		expect(rules(trace())).toEqual([]);
	});

	it("reports what a screen reader gets without a name", () => {
		const t = trace({
			lang: "",
			title: "",
			ax: [
				{ role: "button", name: "", ignored: false },
				{ role: "image", name: "", ignored: false },
				{ role: "button", name: "", ignored: true },
				{ role: "generic", name: "", ignored: false },
			],
		});
		expect(rules(t).sort()).toEqual(["ax-image-name", "ax-name", "page-lang", "page-title"]);
	});

	it("follows the Tab order: back up the page, hidden focus, small targets", () => {
		const focus = [
			stop({ tag: "A", href: "#main", top: 0 }),
			stop({ top: 400 }),
			stop({ top: 100, label: "Up" }),
			stop({ top: 500, outlineVisible: false, label: "Hidden" }),
			stop({ top: 600, width: 16, height: 16, label: "Tiny" }),
		];
		expect(rules(trace({ focus })).sort()).toEqual(["focus-order", "focus-visible", "target-size"]);
	});

	it("asks for a skip link only when there is navigation to skip", () => {
		const many = Array.from({ length: 8 }, (_, i) => stop({ top: i * 50, label: `L${i}` }));
		expect(rules(trace({ focus: many }))).toContain("skip-link");
		expect(rules(trace({ focus: many.slice(0, 3) }))).not.toContain("skip-link");
	});

	it("reports a page nothing can be tabbed to, and a modal that lets the focus out", () => {
		const t = trace({ focus: [], dialogs: [{ label: "Login", stayedInside: false }] });
		expect(rules(t).sort()).toEqual(["dialog-focus", "no-focusable"]);
	});

	it("measures rendered contrast, enhanced only at AAA, never on an unknown background", () => {
		const samples = [
			{ text: "grey", color: "rgb(170, 170, 170)", background: "rgb(255, 255, 255)", fontSizePx: 14, fontWeight: 400 },
			{ text: "ok AA", color: "rgb(110, 110, 110)", background: "rgb(255, 255, 255)", fontSizePx: 14, fontWeight: 400 },
			{ text: "on image", color: "rgb(170, 170, 170)", background: null, fontSizePx: 14, fontWeight: 400 },
		];
		expect(rules(trace({ samples }))).toEqual(["color-contrast"]);
		expect(rules(trace({ samples }), "AAA")).toEqual(["color-contrast", "color-contrast-enhanced"]);
	});

	it("keeps the same finding once and leaves AA rules out at level A", () => {
		const focus = [stop({ tag: "A", href: "#main", top: 0 }), stop({ outlineVisible: false }), stop({ outlineVisible: false })];
		expect(rules(trace({ focus }))).toEqual(["focus-visible"]);
		expect(rules(trace({ focus }), "A")).toEqual([]);
	});

	it("names the page by its path, not its host", () => {
		const [v] = analyseTrace(trace({ title: "" }), "AA");
		expect(v.file).toBe("/cart?x=1");
		expect(v.dynamic).toBe(true);
	});
});

describe("sanitizeTrace", () => {
	it("keeps bounded plain fields only", () => {
		const t = sanitizeTrace(
			{ lang: "x".repeat(500), focus: [{ tag: { evil: true }, top: "1", label: "a".repeat(999) }], ax: "nope" },
			"http://localhost/",
		);
		expect(t.lang).toHaveLength(40);
		expect(t.focus[0].tag).toBe("");
		expect(t.focus[0].top).toBe(0);
		expect(t.focus[0].label.length).toBeLessThanOrEqual(160);
		expect(t.ax).toEqual([]);
	});
});

describe("contrast", () => {
	it("computes the WCAG ratio from computed colours", () => {
		const black = parseRgb("rgb(0, 0, 0)");
		const white = parseRgb("rgba(255, 255, 255, 1)");
		expect(black && white && contrastRatio(black, white)).toBe(21);
		const glass = parseRgb("rgba(255, 255, 255, 0.5)");
		expect(black && glass && contrastRatio(black, glass)).toBeNull();
	});
});
