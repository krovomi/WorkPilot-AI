/**
 * Width of the left menu (rail + panel), in CSS pixels. Pure helpers so the
 * resize handle's rules are tested without a DOM.
 */

/** Width of the rail alone: what stays on screen while the panel is folded. */
export const SIDEBAR_RAIL_WIDTH = 52; // w-13 of SidebarRail
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 296;

/** The main view keeps at least this much room beside the menu. */
export const MAIN_MIN_WIDTH = 560;

/** Dragging this far under the minimum folds the panel on release. */
export const FOLD_THRESHOLD = 72;

/** Arrow keys move the edge by a small step, Shift + arrow by a large one. */
export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 64;

/** The widest the menu may be in a window this wide (never under the minimum). */
export function maxWidthFor(viewportWidth: number): number {
	if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return SIDEBAR_MAX_WIDTH;
	return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - MAIN_MIN_WIDTH));
}

/**
 * A width the menu can take: a stored value that is missing or broken falls
 * back to the default, anything else is rounded and kept between the bounds.
 */
export function clampSidebarWidth(
	value: number | undefined | null,
	viewportWidth: number = Number.POSITIVE_INFINITY,
): number {
	const max = maxWidthFor(viewportWidth);
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return Math.min(SIDEBAR_DEFAULT_WIDTH, max);
	}
	return Math.round(Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, value)));
}

export interface DragOutcome {
	/** The panel folds (only the rail stays). */
	readonly folded: boolean;
	/** The width shown while unfolded. */
	readonly width: number;
}

/**
 * Where a drag of the menu's edge lands: `startWidth` is the width shown when
 * the drag began (the rail's width when folded), `deltaX` how far the pointer
 * moved. Well under the minimum folds the panel; past that it unfolds again.
 */
export function dragOutcome(
	startWidth: number,
	deltaX: number,
	viewportWidth: number,
	foldedWidth: number,
): DragOutcome {
	const raw = startWidth + deltaX;
	if (raw < SIDEBAR_MIN_WIDTH - FOLD_THRESHOLD) {
		return { folded: true, width: foldedWidth };
	}
	return { folded: false, width: clampSidebarWidth(raw, viewportWidth) };
}

export type SidebarKeyAction =
	| { readonly kind: "resize"; readonly width: number }
	| { readonly kind: "toggle" }
	| { readonly kind: "none" };

/**
 * What a key does on the focused edge (WAI-ARIA window splitter pattern):
 * arrows resize, Home and End go to the bounds, Enter folds or unfolds the
 * panel. While folded, an arrow to the right unfolds it.
 */
export function keyAction(
	key: string,
	shiftKey: boolean,
	width: number,
	isFolded: boolean,
	viewportWidth: number,
): SidebarKeyAction {
	const step = shiftKey ? KEY_STEP_LARGE : KEY_STEP;
	switch (key) {
		case "Enter":
			return { kind: "toggle" };
		case "ArrowRight":
			if (isFolded) return { kind: "toggle" };
			return { kind: "resize", width: clampSidebarWidth(width + step, viewportWidth) };
		case "ArrowLeft":
			if (isFolded) return { kind: "none" };
			return { kind: "resize", width: clampSidebarWidth(width - step, viewportWidth) };
		case "Home":
			return isFolded ? { kind: "none" } : { kind: "resize", width: SIDEBAR_MIN_WIDTH };
		case "End":
			return isFolded
				? { kind: "none" }
				: { kind: "resize", width: maxWidthFor(viewportWidth) };
		default:
			return { kind: "none" };
	}
}
