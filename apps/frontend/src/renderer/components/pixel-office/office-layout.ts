/**
 * Office geometry — where the desks are, and how many of them there are.
 *
 * This used to be six constants in the canvas: four desks per row, three rows,
 * `seatIndex % 4` for the column and `Math.floor(seatIndex / 4) % 3` for the
 * row. Twelve desks, and then the modulo silently sat the thirteenth agent on
 * top of the first — with a terminal cap of 12 plus Kanban tasks plus swarm
 * subtasks, thirteen is an ordinary Tuesday. The canvas also only ever drew
 * `max(agentCount, 4)` desks while the store handed out ever-increasing seat
 * indices, so an agent holding seat 7 in a five-agent office was simply not
 * rendered anywhere.
 *
 * So the grid is computed from the two things that actually determine it: how
 * many agents need a desk, and how much room there is to put them in. It lives
 * apart from the canvas because it is arithmetic, and arithmetic is the part
 * worth testing without a rendering context.
 */

import { CHAIR_H, DESK_H, SPRITE_H, TILE_SIZE } from "./pixel-sprites";

/** Horizontal distance between two desks, in tiles. */
export const DESK_SPACING_X = 5;
/** Vertical distance between two desk rows, in tiles. */
export const DESK_SPACING_Y = 5;
/** Left margin before the first desk column, in tiles. */
export const DESK_START_X = 3;
/** Top margin (below the wall) before the first desk row, in tiles. */
export const DESK_START_Y = 2;

/** A desk occupies two tiles across. */
export const DESK_W = 32;

/** Vertical offset from the desk's top-left to the character's head, in tiles. */
export const CHAR_OFFSET_Y = (DESK_H + CHAIR_H) / TILE_SIZE;

/** Clickable height of one workstation (desk + chair + character), in pixels. */
export const SEAT_HIT_H = DESK_H + CHAIR_H + SPRITE_H;

/** Never fewer than this many desks per row — a single column reads as a queue. */
const MIN_DESKS_PER_ROW = 2;
/** Never more — beyond this the characters are too small to tell apart. */
const MAX_DESKS_PER_ROW = 8;
/** Desks drawn even when the office is empty, so the room looks like a room. */
const MIN_DESKS = 4;

/** Right margin after the last desk column, in tiles. */
const MARGIN_RIGHT = 2;
/** Bottom margin after the last desk row, in tiles — room for the name labels. */
const MARGIN_BOTTOM = 3;

export interface TilePosition {
	readonly x: number;
	readonly y: number;
}

export interface OfficeLayout {
	/** Office width in tiles. */
	readonly cols: number;
	/** Office height in tiles. */
	readonly rows: number;
	/** Desks per row in this layout. */
	readonly desksPerRow: number;
	/** Number of desk rows in this layout. */
	readonly deskRows: number;
	/** Total desks drawn — every seat index below this is visible. */
	readonly seatCount: number;
}

/**
 * How many desks fit across a viewport of `viewportW` CSS pixels at `zoom`.
 * Returns the minimum when nothing fits: a cramped office still beats an empty
 * one, and the canvas scrolls the overflow off-centre rather than hiding it.
 */
function fitDesksPerRow(viewportW: number, zoom: number): number {
	if (!Number.isFinite(viewportW) || viewportW <= 0) return MIN_DESKS_PER_ROW;
	const usable = viewportW / (TILE_SIZE * zoom) - DESK_START_X - MARGIN_RIGHT;
	const fits = Math.floor(usable / DESK_SPACING_X);
	return Math.min(MAX_DESKS_PER_ROW, Math.max(MIN_DESKS_PER_ROW, fits));
}

/**
 * Build the desk grid for `seatCount` agents inside a viewport.
 *
 * The office grows to hold every seat. It is never sized to hide one: a seat
 * index the store handed out and the canvas does not draw is an agent the user
 * cannot see or click, which is the failure this function exists to prevent.
 */
export function computeOfficeLayout(
	seatCount: number,
	viewportW: number,
	zoom: number,
): OfficeLayout {
	const desks = Math.max(MIN_DESKS, Math.ceil(seatCount));
	const desksPerRow = Math.min(fitDesksPerRow(viewportW, zoom), desks);
	const deskRows = Math.ceil(desks / desksPerRow);

	return {
		cols: DESK_START_X + desksPerRow * DESK_SPACING_X + MARGIN_RIGHT,
		rows: DESK_START_Y + deskRows * DESK_SPACING_Y + MARGIN_BOTTOM,
		desksPerRow,
		deskRows,
		seatCount: desks,
	};
}

/** Top-left tile of the desk at `seatIndex`. Rows do not wrap. */
export function seatPosition(
	layout: OfficeLayout,
	seatIndex: number,
): TilePosition {
	const col = seatIndex % layout.desksPerRow;
	const row = Math.floor(seatIndex / layout.desksPerRow);
	return {
		x: DESK_START_X + col * DESK_SPACING_X,
		y: DESK_START_Y + row * DESK_SPACING_Y,
	};
}

/** The office is never drawn smaller than this, however cramped the canvas. */
const MIN_SCALE = 0.05;

export interface OfficeViewport {
	/**
	 * Extra scale applied on top of the zoom so the whole office fits the canvas.
	 * Never above 1: zooming past what the user asked for is not fitting.
	 */
	readonly scale: number;
	/** Left offset of the drawn office inside the canvas, in CSS pixels. */
	readonly offsetX: number;
	/** Top offset of the drawn office inside the canvas, in CSS pixels. */
	readonly offsetY: number;
}

/**
 * Place the office inside the canvas.
 *
 * Both the renderer and the click hit-test need this answer and they need the
 * same one — they disagreed before, because the renderer centred using
 * `canvas.width` (device pixels, twice the CSS size on a HiDPI screen) against
 * a context already scaled by the device pixel ratio, so on a Retina display
 * the room was drawn well to the right of where clicks were being resolved.
 *
 * Sizes here are CSS pixels throughout. The device pixel ratio belongs to the
 * backing store and nothing else.
 */
export function computeViewport(
	layout: OfficeLayout,
	zoom: number,
	canvasW: number,
	canvasH: number,
): OfficeViewport {
	const officeW = layout.cols * TILE_SIZE * zoom;
	const officeH = layout.rows * TILE_SIZE * zoom;
	// A tall office is shrunk to fit rather than cropped: an agent below the fold
	// is an agent the user cannot see or click, which is the same failure as an
	// agent with no desk.
	//
	// The scale is floored above zero and defaults to 1 for an unmeasured canvas
	// — every hit-test divides by it, and the first frame runs before the
	// ResizeObserver has reported anything.
	const fits =
		canvasW > 0 && canvasH > 0
			? Math.min(canvasW / officeW, canvasH / officeH)
			: 1;
	const scale = Math.min(1, Math.max(fits, MIN_SCALE));
	return {
		scale,
		offsetX: Math.max(0, (canvasW - officeW * scale) / 2),
		offsetY: Math.max(0, (canvasH - officeH * scale) / 2),
	};
}

/** Convert a point in canvas CSS pixels to office pixels. */
export function toOfficePoint(
	viewport: OfficeViewport,
	canvasX: number,
	canvasY: number,
): TilePosition {
	return {
		x: (canvasX - viewport.offsetX) / viewport.scale,
		y: (canvasY - viewport.offsetY) / viewport.scale,
	};
}
