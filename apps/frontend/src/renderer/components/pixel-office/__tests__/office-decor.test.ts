/**
 * @vitest-environment jsdom
 *
 * Each piece of season decor has its spot on the back wall or the free strip
 * of floor in front of it, above the first row of desks.
 */
import { describe, expect, it } from "vitest";
import { DECOR_IDS } from "../../../lib/pixel-office-seasons";
import { decorSpot, drawSeasonDecor } from "../office-decor";
import { computeOfficeLayout, DESK_START_Y } from "../office-layout";
import { installFakeCanvas } from "./fake-canvas";

describe("season decor", () => {
	const layout = computeOfficeLayout(4, 800, 3);

	it("puts every piece above the desks, inside the room, each in its own place", () => {
		const spots = DECOR_IDS.map((id) => decorSpot(id, layout));
		for (const { col, row } of spots) {
			expect(row).toBeLessThan(DESK_START_Y);
			expect(col).toBeGreaterThanOrEqual(1);
			expect(col).toBeLessThan(layout.cols);
		}
		expect(new Set(spots.map((s) => `${s.col}:${s.row}`)).size).toBe(DECOR_IDS.length);
	});

	it("draws only the decor it is given", () => {
		const contextOf = installFakeCanvas();
		const canvas = document.createElement("canvas");
		const fake = contextOf(canvas);
		const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
		drawSeasonDecor(ctx, layout, 2, []);
		expect(fake.calls).toEqual([]);
		for (const id of DECOR_IDS) {
			fake.calls.length = 0;
			drawSeasonDecor(ctx, layout, 2, [id]);
			expect(fake.calls.length).toBeGreaterThan(0);
		}
		fake.calls.length = 0;
		drawSeasonDecor(ctx, layout, 2, ["neon-sign"]);
		expect(fake.calls.map((c) => c.fillStyle)).toContain("#F472B6");
	});
});
