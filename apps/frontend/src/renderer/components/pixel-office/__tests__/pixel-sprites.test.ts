/**
 * @vitest-environment jsdom
 *
 * Sprites are painted once per key and then reused, every palette reaches a
 * character, and each activity has its own icon.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	CHAIR_H,
	CHARACTER_PALETTES,
	DESK_H,
	getActivityIcon,
	getChairSprite,
	getCharacterSprite,
	getDeskSprite,
	getFloorTile,
	getWallTile,
	SPRITE_H,
	SPRITE_W,
	TILE_SIZE,
} from "../pixel-sprites";
import { type FakeContext, installFakeCanvas } from "./fake-canvas";

// Sprites are cached for the life of the module, so one recording context per
// canvas has to outlive each test.
let contextOf: (canvas: HTMLCanvasElement) => FakeContext;

beforeAll(() => {
	contextOf = installFakeCanvas();
});

afterAll(() => {
	vi.restoreAllMocks();
});

function colours(canvas: HTMLCanvasElement): Set<unknown> {
	return new Set(
		contextOf(canvas)
			.calls.filter((c) => c.name === "fillRect")
			.map((c) => c.fillStyle),
	);
}

describe("getCharacterSprite", () => {
	it("paints a character in its palette, once", () => {
		const sprite = getCharacterSprite(0, "down", 0);
		expect([sprite.width, sprite.height]).toEqual([SPRITE_W, SPRITE_H]);
		const palette = CHARACTER_PALETTES[0];
		expect(colours(sprite)).toEqual(
			new Set([
				palette.hair,
				palette.skin,
				"#1A1A2E",
				palette.shirt,
				palette.pants,
				palette.shoes,
			]),
		);
		expect(getCharacterSprite(0, "down", 0)).toBe(sprite);
	});

	it("wraps the character index around the palettes", () => {
		const wrapped = getCharacterSprite(CHARACTER_PALETTES.length + 1, "down", 0);
		expect(colours(wrapped).has(CHARACTER_PALETTES[1].shirt)).toBe(true);
	});

	it("shows the back of the head when facing the desk, and eyes otherwise", () => {
		const eyes = (canvas: HTMLCanvasElement) =>
			contextOf(canvas)
				.calls.filter(
					(c) => c.name === "fillRect" && c.fillStyle === "#1A1A2E" && c.args[1] === 5,
				)
				.map((c) => c.args[0]);
		expect(eyes(getCharacterSprite(2, "up", 0))).toEqual([]);
		expect(eyes(getCharacterSprite(2, "down", 0))).toEqual([6, 9]);
		expect(eyes(getCharacterSprite(2, "left", 0))).toEqual([5, 8]);
		expect(eyes(getCharacterSprite(2, "right", 0))).toEqual([7, 10]);
	});

	it("moves the arms and spreads the legs on the second frame", () => {
		const shoes = CHARACTER_PALETTES[3].shoes;
		const shoeCount = (canvas: HTMLCanvasElement) =>
			contextOf(canvas).calls.filter(
				(c) => c.name === "fillRect" && c.fillStyle === shoes,
			).length;
		expect(shoeCount(getCharacterSprite(3, "down", 1))).toBe(
			shoeCount(getCharacterSprite(3, "down", 0)) + 2,
		);
	});
});

describe("furniture and tiles", () => {
	it("paints each piece at its size, once", () => {
		const desk = getDeskSprite();
		const chair = getChairSprite();
		const floor = getFloorTile();
		const wall = getWallTile();
		expect([desk.width, desk.height]).toEqual([32, DESK_H]);
		expect([chair.width, chair.height]).toEqual([32, CHAIR_H]);
		expect([floor.width, floor.height]).toEqual([TILE_SIZE, TILE_SIZE]);
		expect([wall.width, wall.height]).toEqual([TILE_SIZE, TILE_SIZE]);
		expect(colours(desk).has("#1A5FD4")).toBe(true);
		expect(colours(chair).has("#2A2A4E")).toBe(true);
		expect(contextOf(floor).calls.some((c) => c.name === "strokeRect")).toBe(true);
		expect(contextOf(wall).calls.filter((c) => c.name === "stroke")).toHaveLength(2);

		expect(getDeskSprite()).toBe(desk);
		expect(getChairSprite()).toBe(chair);
		expect(getFloorTile()).toBe(floor);
		expect(getWallTile()).toBe(wall);
	});
});

describe("getActivityIcon", () => {
	it("draws a different icon for each activity", () => {
		expect(colours(getActivityIcon("typing", 1)).has("#4A90D9")).toBe(true);
		expect(colours(getActivityIcon("reading", 0)).has("#27AE60")).toBe(true);
		expect(colours(getActivityIcon("running", 0)).has("#1ABC9C")).toBe(true);
		expect(colours(getActivityIcon("waiting", 0)).has("#F39C12")).toBe(true);
	});

	it("blinks the typing cursor on the first frame only", () => {
		expect(colours(getActivityIcon("typing", 0)).has("#FFD700")).toBe(true);
		expect(colours(getActivityIcon("typing", 1)).has("#FFD700")).toBe(false);
	});

	it("animates over two frames, whatever frame number it is given", () => {
		expect(getActivityIcon("waiting", 2)).toBe(getActivityIcon("waiting", 0));
		expect(getActivityIcon("waiting", 3)).not.toBe(getActivityIcon("waiting", 2));
		const prompt = (canvas: HTMLCanvasElement) =>
			contextOf(canvas).calls.find((c) => c.name === "fillRect" && c.args[1] === 5)
				?.args[2];
		expect(prompt(getActivityIcon("running", 1))).toBe(4);
	});
});

describe("without a 2D context", () => {
	it("says so instead of returning a blank sprite", () => {
		vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null);
		expect(() => getCharacterSprite(42, "down", 0)).toThrow(
			"Could not get 2D context",
		);
	});
});
