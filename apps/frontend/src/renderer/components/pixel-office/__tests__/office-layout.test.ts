import { describe, expect, it } from "vitest";
import {
	computeOfficeLayout,
	computeViewport,
	DESK_SPACING_X,
	DESK_START_X,
	seatPosition,
	toOfficePoint,
} from "../office-layout";
import { TILE_SIZE } from "../pixel-sprites";

/** A wide viewport, so `desksPerRow` is not clamped by the fit. */
const WIDE = 4000;

describe("computeOfficeLayout", () => {
	it("draws at least one desk for every agent", () => {
		for (const agents of [0, 1, 5, 12, 13, 40]) {
			const layout = computeOfficeLayout(agents, WIDE, 3);
			expect(layout.seatCount).toBeGreaterThanOrEqual(agents);
		}
	});

	/**
	 * The old grid was four columns by three rows with `% 3` on the row, so seat
	 * 12 landed exactly on seat 0. Twelve terminals is the documented cap and
	 * Kanban tasks and swarm subtasks sit at the same desks, so the collision was
	 * reachable by opening one more card.
	 */
	it("gives every seat its own position", () => {
		const layout = computeOfficeLayout(40, WIDE, 3);
		const seen = new Set<string>();
		for (let seat = 0; seat < layout.seatCount; seat++) {
			const pos = seatPosition(layout, seat);
			seen.add(`${pos.x},${pos.y}`);
		}
		expect(seen.size).toBe(layout.seatCount);
	});

	it("keeps every desk inside the office it reports", () => {
		const layout = computeOfficeLayout(37, WIDE, 3);
		for (let seat = 0; seat < layout.seatCount; seat++) {
			const pos = seatPosition(layout, seat);
			expect(pos.x).toBeLessThan(layout.cols);
			expect(pos.y).toBeLessThan(layout.rows);
		}
	});

	it("narrows the rows when the viewport cannot hold them", () => {
		const roomFor3 = (DESK_START_X + 3 * DESK_SPACING_X) * TILE_SIZE * 3;
		const narrow = computeOfficeLayout(12, roomFor3, 3);
		const wide = computeOfficeLayout(12, WIDE, 3);
		expect(narrow.desksPerRow).toBeLessThan(wide.desksPerRow);
		expect(narrow.deskRows).toBeGreaterThan(wide.deskRows);
	});

	it("never collapses to a single column", () => {
		const layout = computeOfficeLayout(6, 10, 6);
		expect(layout.desksPerRow).toBeGreaterThanOrEqual(2);
	});

	it("draws a furnished room when nobody is in it", () => {
		expect(computeOfficeLayout(0, WIDE, 3).seatCount).toBe(4);
	});
});

describe("computeViewport", () => {
	it("centres an office smaller than the canvas without scaling it", () => {
		const layout = computeOfficeLayout(4, WIDE, 2);
		const viewport = computeViewport(layout, 2, 3000, 2000);
		expect(viewport.scale).toBe(1);
		expect(viewport.offsetX).toBeGreaterThan(0);
		expect(viewport.offsetY).toBeGreaterThan(0);
	});

	it("shrinks an office taller than the canvas instead of cropping it", () => {
		const layout = computeOfficeLayout(40, 900, 4);
		const viewport = computeViewport(layout, 4, 900, 400);
		expect(viewport.scale).toBeLessThan(1);
		const drawnH = layout.rows * TILE_SIZE * 4 * viewport.scale;
		expect(drawnH).toBeLessThanOrEqual(400 + 0.001);
	});

	/**
	 * The renderer used to centre with `canvas.width` — device pixels — against a
	 * context already scaled by the device pixel ratio, while the hit-test used
	 * the CSS-pixel rect. On a HiDPI screen the two disagreed by a factor of the
	 * ratio and clicks landed on the wrong desk, or on none.
	 */
	it("round-trips a desk's own corner back to itself", () => {
		const layout = computeOfficeLayout(9, 1200, 3);
		const viewport = computeViewport(layout, 3, 1200, 700);
		for (let seat = 0; seat < layout.seatCount; seat++) {
			const pos = seatPosition(layout, seat);
			const officeX = pos.x * TILE_SIZE * 3;
			const officeY = pos.y * TILE_SIZE * 3;
			const canvasX = officeX * viewport.scale + viewport.offsetX;
			const canvasY = officeY * viewport.scale + viewport.offsetY;
			const back = toOfficePoint(viewport, canvasX, canvasY);
			expect(back.x).toBeCloseTo(officeX, 6);
			expect(back.y).toBeCloseTo(officeY, 6);
		}
	});
});

describe("computeViewport degenerate inputs", () => {
	/** Every hit-test divides by the scale, and the first frame runs unmeasured. */
	it.each([
		["unmeasured", 0, 0],
		["zero width", 0, 500],
		["zero height", 900, 0],
		["one pixel", 1, 1],
	])("keeps the scale usable for a %s canvas", (_label, w, h) => {
		const layout = computeOfficeLayout(6, w, 3);
		const viewport = computeViewport(layout, 3, w, h);
		expect(viewport.scale).toBeGreaterThan(0);
		expect(Number.isFinite(viewport.scale)).toBe(true);
		expect(Number.isFinite(viewport.offsetX)).toBe(true);
		expect(Number.isFinite(viewport.offsetY)).toBe(true);
	});
});
