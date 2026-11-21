/**
 * The boxes drawn over a matrix capture (#383): each faulty element becomes a
 * share of the viewport, cut at its edges; what lies outside the captured
 * viewport is not boxed, and there are never more than MAX_MARKERS.
 */
import { describe, expect, it } from "vitest";
import type { ResponsiveReport } from "../../types/device-matrix";
import { MAX_MARKERS, issueMarkers } from "../issue-markers";

const report = (samples: { x: number; y: number; width: number; height: number }[]): ResponsiveReport => ({
	viewportWidth: 400,
	scrollWidth: 400,
	scanned: samples.length,
	truncated: false,
	issues: [{ kind: "small-text", count: samples.length, samples: samples.map((box) => ({ selector: "p", ...box })) }],
});

describe("issueMarkers", () => {
	it("turns a box into a share of the viewport", () => {
		expect(issueMarkers(report([{ x: 40, y: 200, width: 200, height: 100 }]), 400, 800)).toEqual([
			{ kind: "small-text", selector: "p", x: 0.1, y: 0.25, width: 0.5, height: 0.125 },
		]);
	});

	it("cuts a box at the edges of the viewport, and keeps a sliver visible", () => {
		const [wide, thin] = issueMarkers(
			report([
				{ x: -100, y: 700, width: 700, height: 300 },
				{ x: 399.9, y: 0, width: 0, height: 0 },
			]),
			400,
			800,
		);
		expect(wide).toMatchObject({ x: 0, y: 0.875, width: 1, height: 0.125 });
		expect(thin.width).toBeGreaterThan(0);
		expect(thin.x + thin.width).toBeLessThanOrEqual(1);
	});

	it("leaves out what is below the fold or beside the screen", () => {
		const boxes = [
			{ x: 0, y: 900, width: 50, height: 50 },
			{ x: 0, y: -80, width: 50, height: 50 },
			{ x: 450, y: 0, width: 50, height: 50 },
			{ x: -80, y: 0, width: 50, height: 50 },
		];
		expect(issueMarkers(report(boxes), 400, 800)).toEqual([]);
	});

	it("draws nothing without a report or a viewport, and stops at MAX_MARKERS", () => {
		expect(issueMarkers(null, 400, 800)).toEqual([]);
		expect(issueMarkers(report([{ x: 0, y: 0, width: 1, height: 1 }]), 0, 800)).toEqual([]);
		expect(issueMarkers(report([{ x: 0, y: 0, width: 1, height: 1 }]), 400, 0)).toEqual([]);
		const many = Array.from({ length: MAX_MARKERS + 5 }, (_, index) => ({ x: index, y: 0, width: 10, height: 10 }));
		expect(issueMarkers(report(many), 400, 800)).toHaveLength(MAX_MARKERS);
	});
});
