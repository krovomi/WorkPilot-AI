/**
 * The rules of the menu's width: bounds, the room kept for the main view,
 * folding by dragging, and what each key does on the focused edge.
 */
import { describe, expect, it } from "vitest";
import {
	clampSidebarWidth,
	dragOutcome,
	FOLD_THRESHOLD,
	KEY_STEP,
	KEY_STEP_LARGE,
	keyAction,
	MAIN_MIN_WIDTH,
	maxWidthFor,
	SIDEBAR_DEFAULT_WIDTH,
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
	SIDEBAR_RAIL_WIDTH,
} from "../sidebar-width";

const WIDE = 1920;

describe("maxWidthFor", () => {
	it("is the maximum in a wide window", () => {
		expect(maxWidthFor(WIDE)).toBe(SIDEBAR_MAX_WIDTH);
	});

	it("leaves the main view its room in a narrow window, never under the minimum", () => {
		expect(maxWidthFor(900)).toBe(900 - MAIN_MIN_WIDTH);
		expect(maxWidthFor(600)).toBe(SIDEBAR_MIN_WIDTH);
	});

	it("ignores a window width that makes no sense", () => {
		expect(maxWidthFor(0)).toBe(SIDEBAR_MAX_WIDTH);
		expect(maxWidthFor(Number.NaN)).toBe(SIDEBAR_MAX_WIDTH);
	});
});

describe("clampSidebarWidth", () => {
	it("falls back to the default for a missing or broken value", () => {
		expect(clampSidebarWidth(undefined)).toBe(SIDEBAR_DEFAULT_WIDTH);
		expect(clampSidebarWidth(null)).toBe(SIDEBAR_DEFAULT_WIDTH);
		expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
		expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
	});

	it("never offers the default wider than the window allows", () => {
		expect(clampSidebarWidth(undefined, 600)).toBe(SIDEBAR_MIN_WIDTH);
	});

	it("keeps a value between the bounds and rounds it", () => {
		expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH);
		expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
		expect(clampSidebarWidth(300.6)).toBe(301);
		expect(clampSidebarWidth(470, 900)).toBe(900 - MAIN_MIN_WIDTH);
	});
});

describe("dragOutcome", () => {
	it("follows the pointer within the bounds", () => {
		expect(dragOutcome(296, 40, WIDE, SIDEBAR_RAIL_WIDTH)).toEqual({ folded: false, width: 336 });
		expect(dragOutcome(296, 900, WIDE, SIDEBAR_RAIL_WIDTH)).toEqual({
			folded: false,
			width: SIDEBAR_MAX_WIDTH,
		});
	});

	it("stops at the minimum, then folds once well under it", () => {
		const atThreshold = SIDEBAR_MIN_WIDTH - FOLD_THRESHOLD - 296;
		expect(dragOutcome(296, atThreshold, WIDE, SIDEBAR_RAIL_WIDTH)).toEqual({
			folded: false,
			width: SIDEBAR_MIN_WIDTH,
		});
		expect(dragOutcome(296, atThreshold - 1, WIDE, SIDEBAR_RAIL_WIDTH)).toEqual({
			folded: true,
			width: SIDEBAR_RAIL_WIDTH,
		});
	});

	it("unfolds a folded menu dragged far enough to the right", () => {
		expect(dragOutcome(SIDEBAR_RAIL_WIDTH, 40, WIDE, SIDEBAR_RAIL_WIDTH).folded).toBe(true);
		expect(dragOutcome(SIDEBAR_RAIL_WIDTH, 300, WIDE, SIDEBAR_RAIL_WIDTH)).toEqual({
			folded: false,
			width: 352,
		});
	});
});

describe("keyAction", () => {
	it("resizes with the arrows, by a large step with Shift", () => {
		expect(keyAction("ArrowRight", false, 296, false, WIDE)).toEqual({
			kind: "resize",
			width: 296 + KEY_STEP,
		});
		expect(keyAction("ArrowLeft", true, 400, false, WIDE)).toEqual({
			kind: "resize",
			width: 400 - KEY_STEP_LARGE,
		});
		expect(keyAction("ArrowLeft", false, SIDEBAR_MIN_WIDTH, false, WIDE)).toEqual({
			kind: "resize",
			width: SIDEBAR_MIN_WIDTH,
		});
	});

	it("goes to the bounds with Home and End", () => {
		expect(keyAction("Home", false, 400, false, WIDE)).toEqual({
			kind: "resize",
			width: SIDEBAR_MIN_WIDTH,
		});
		expect(keyAction("End", false, 300, false, 900)).toEqual({
			kind: "resize",
			width: 900 - MAIN_MIN_WIDTH,
		});
	});

	it("folds or unfolds with Enter, unfolds with the right arrow", () => {
		expect(keyAction("Enter", false, 296, false, WIDE)).toEqual({ kind: "toggle" });
		expect(keyAction("Enter", false, 296, true, WIDE)).toEqual({ kind: "toggle" });
		expect(keyAction("ArrowRight", false, 296, true, WIDE)).toEqual({ kind: "toggle" });
	});

	it("does nothing for other keys, nor for resizing keys while folded", () => {
		expect(keyAction("a", false, 296, false, WIDE)).toEqual({ kind: "none" });
		expect(keyAction("ArrowLeft", false, 296, true, WIDE)).toEqual({ kind: "none" });
		expect(keyAction("Home", false, 296, true, WIDE)).toEqual({ kind: "none" });
		expect(keyAction("End", false, 296, true, WIDE)).toEqual({ kind: "none" });
	});
});
