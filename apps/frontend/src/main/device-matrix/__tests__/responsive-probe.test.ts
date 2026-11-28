/**
 * @vitest-environment jsdom
 */
/**
 * The responsive reading of a rendered page (#383): the probe finds the
 * classic bugs in a laid-out DOM, reads only, and stops at its bounds; what
 * the page answers is reshaped and bounded before it leaves the main.
 *
 * jsdom has no layout, so each element carries its box in `data-box`
 * (`left,top,width,height`) and the probe's `getBoundingClientRect` reads it;
 * its content size, in `data-scroll` (`scrollWidth,clientWidth,scrollHeight,clientHeight`).
 */
import { describe, expect, it } from "vitest";
import {
	MAX_ELEMENTS,
	MAX_MENU_TOGGLES,
	MAX_NAVIGATIONS,
	MAX_NAV_LINKS,
	MAX_OVERLAP_CANDIDATES,
	MAX_SAMPLES,
	MIN_OVERLAP_RATIO,
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
	const metrics = ["scrollWidth", "clientWidth", "scrollHeight", "clientHeight"];
	metrics.forEach((name, index) => {
		Object.defineProperty(window.HTMLElement.prototype, name, {
			configurable: true,
			get(this: HTMLElement) {
				return Number((this.getAttribute("data-scroll") ?? "0,0,0,0").split(",")[index]);
			},
		});
	});
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
			nav: false,
			minTouch: MIN_TOUCH_TARGET_PX,
			minText: MIN_TEXT_PX,
			maxSamples: MAX_SAMPLES,
			maxElements: MAX_ELEMENTS,
			maxCandidates: MAX_OVERLAP_CANDIDATES,
			minOverlap: MIN_OVERLAP_RATIO,
			maxNavs: MAX_NAVIGATIONS,
			maxLinks: MAX_NAV_LINKS,
			maxToggles: MAX_MENU_TOGGLES,
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

	it("names two contents that overlap, by their intersection", () => {
		const output = probe(
			'<p id="title" data-box="0,0,200,40">Title</p>' +
				'<button class="cta" data-box="150,10,100,40">Go</button>' +
				'<p data-box="0,100,200,40">apart</p>',
			{ mobile: false, touch: false },
		);
		const overlap = kind(output, "overlapping-elements");
		expect(overlap?.count).toBe(1);
		expect(overlap?.samples[0]).toMatchObject({ selector: "p#title / button.cta", width: 50 });
	});

	it("does not count nesting, a touch, a sliver, an invisible or an empty element", () => {
		const output = probe(
			// A parent and its own child: contained, not overlapping.
			'<div style="overflow-x: visible" data-box="0,0,300,100">text<span data-box="10,10,50,20">in</span></div>' +
				// Lines that touch: 2 px.
				'<p data-box="0,200,200,20">one</p><p data-box="0,218,200,20">two</p>' +
				// Under MIN_OVERLAP_RATIO of the smaller box.
				'<p data-box="0,300,100,100">left</p><p data-box="80,300,100,100">right</p>' +
				// Transparent, or with nothing to show.
				'<p style="opacity: 0" data-box="0,500,100,40">ghost</p><p data-box="0,500,100,40">shown</p>' +
				'<div data-box="0,600,100,40"></div><div data-box="0,600,100,40"></div>',
			{ mobile: false, touch: false },
		);
		expect(kind(output, "overlapping-elements")?.count).toBe(0);
	});

	it("leaves fixed, sticky and absolute layers, and what is inside them, alone", () => {
		const output = probe(
			'<p data-box="0,0,200,40">content</p>' +
				'<header style="position: fixed; overflow-x: visible" data-box="0,0,400,50"><a href="/" data-box="0,0,80,50">home</a></header>' +
				'<span style="position: absolute" data-box="10,10,20,20">3</span>' +
				'<nav style="position: sticky" data-box="0,0,400,30">menu</nav>',
			{ mobile: false, touch: false },
		);
		expect(kind(output, "overlapping-elements")?.count).toBe(0);
	});

	it("compares no more than MAX_OVERLAP_CANDIDATES elements", () => {
		const stack = '<b data-box="0,0,50,50">x</b>'.repeat(MAX_OVERLAP_CANDIDATES + 5);
		const overlap = kind(probe(stack, { mobile: false, touch: false }), "overlapping-elements");
		expect(overlap?.count).toBe((MAX_OVERLAP_CANDIDATES * (MAX_OVERLAP_CANDIDATES - 1)) / 2);
		expect(overlap?.samples).toHaveLength(MAX_SAMPLES);
	});

	it("flags text cut off by an ellipsis or a clip, or spilling out of a fixed box, on every device", () => {
		const output = probe(
			'<p class="name" style="overflow-x: hidden; text-overflow: ellipsis" data-box="0,0,100,20" data-scroll="300,100,20,20">A very long name</p>' +
				'<p data-box="0,40,100,40" data-scroll="100,100,90,40">Many lines in a fixed height</p>' +
				// A box that scrolls: nothing is lost.
				'<p style="overflow-x: auto; overflow-y: auto" data-box="0,100,100,40" data-scroll="300,100,90,40">scrolls</p>' +
				// Fits, has no text, is inline, or has no box of its own.
				'<p data-box="0,160,100,20" data-scroll="100,100,20,20">fits</p>' +
				'<div data-box="0,200,100,20" data-scroll="300,100,20,20"></div>' +
				'<span style="display: inline" data-box="0,240,100,20" data-scroll="300,100,20,20">inline</span>' +
				'<p data-box="0,280,100,20" data-scroll="300,0,20,0">empty box</p>',
			{ mobile: false, touch: false },
		);
		const truncated = kind(output, "truncated-text");
		expect(truncated?.count).toBe(2);
		expect(truncated?.samples.map((sample) => sample.selector)).toEqual(["p.name", "p"]);
	});

	it("flags a mobile navigation whose links are all hidden and that no menu button opens", () => {
		const hidden =
			'<nav id="main"><a href="/a" style="display:none">a</a><a href="/b" data-box="-300,0,200,20">b</a></nav>';
		expect(kind(probe(hidden), "broken-navigation")?.samples[0].selector).toBe("nav#main");
		// Desktop pages are not read for it.
		expect(kind(probe(hidden, { mobile: false, touch: false }), "broken-navigation")?.count).toBe(0);
	});

	it.each([
		["a link still shows", '<nav><a href="/a">a</a><a href="/b" style="display:none">b</a></nav>'],
		["a navigation without links", '<div role="navigation"><span>logo</span></div>'],
		[
			"a button that announces what it opens",
			'<button aria-expanded="false">menu</button><nav><a href="/a" style="display:none">a</a></nav>',
		],
		["a disclosure summary", '<details><summary>menu</summary><nav><a href="/a" style="display:none">a</a></nav></details>'],
		[
			"the label of a checkbox (CSS-only menu)",
			'<input type="checkbox" id="burger"><label for="burger">menu</label><nav><a href="/a" style="display:none">a</a></nav>',
		],
	])("leaves a navigation alone when %s", (_label, body) => {
		expect(kind(probe(body), "broken-navigation")?.count).toBe(0);
	});

	it("does not take a hidden button, nor a label of something else, for a menu button", () => {
		const body =
			'<button aria-expanded="false" style="display:none">menu</button>' +
			'<input type="text" id="q"><label for="q">search</label><label for="nowhere">x</label>' +
			'<nav><a href="/a" style="display:none">a</a></nav>';
		expect(kind(probe(body), "broken-navigation")?.count).toBe(1);
	});

	it("flags a menu button that controls nothing on the page", () => {
		const body =
			'<button id="burger" aria-controls="menu drawer">menu</button>' +
			'<button aria-controls="ghost real">ok</button><ul id="real"><li>x</li></ul>' +
			'<button aria-expanded="true">no target named</button>';
		const issue = kind(probe(body), "broken-navigation");
		expect(issue?.count).toBe(1);
		expect(issue?.samples[0].selector).toBe("button#burger");
	});

	it("reads no more than MAX_NAVIGATIONS navigations", () => {
		const navs = '<nav><a href="/a" style="display:none">a</a></nav>'.repeat(MAX_NAVIGATIONS + 3);
		expect(kind(probe(navs), "broken-navigation")?.count).toBe(MAX_NAVIGATIONS);
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

	it("keeps overlaps and cut-off text, in the order of the kinds", () => {
		const report = sanitizeReport({
			issues: [
				{ kind: "truncated-text", count: 1, samples: [{ selector: "p.name" }] },
				{ kind: "overlapping-elements", count: 2, samples: [{ selector: "h1 / button.cta", width: 40 }] },
			],
		});
		expect(report?.issues.map((issue) => [issue.kind, issue.count])).toEqual([
			["overlapping-elements", 2],
			["truncated-text", 1],
		]);
		expect(report?.issues[0].samples[0].selector).toBe("h1 / button.cta");
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
