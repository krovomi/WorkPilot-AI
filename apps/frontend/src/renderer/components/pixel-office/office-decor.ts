/**
 * The decor a project earned in its seasons (`earnedDecor`), drawn on the
 * office's back wall and the strip of floor in front of it, where no desk
 * ever sits (desks start at `DESK_START_Y`). Still pictures: nothing here
 * moves, so calm mode has nothing to stop.
 */

import type { DecorId } from "../../lib/pixel-office-seasons";
import type { OfficeLayout } from "./office-layout";
import { TILE_SIZE } from "./pixel-sprites";

type Paint = (
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	z: number,
) => void;

function rect(
	ctx: CanvasRenderingContext2D,
	color: string,
	x: number,
	y: number,
	w: number,
	h: number,
) {
	ctx.fillStyle = color;
	ctx.fillRect(x, y, w, h);
}

const PAINT: Record<DecorId, Paint> = {
	"trophy-shelf": (ctx, x, y, z) => {
		rect(ctx, "#8B5A2B", x, y + 11 * z, 22 * z, 2 * z);
		for (const dx of [2, 9, 16]) {
			rect(ctx, "#FACC15", x + dx * z, y + 5 * z, 4 * z, 4 * z);
			rect(ctx, "#CA8A04", x + (dx + 1) * z, y + 9 * z, 2 * z, 2 * z);
		}
	},
	whiteboard: (ctx, x, y, z) => {
		rect(ctx, "#9CA3AF", x, y + 2 * z, 26 * z, 12 * z);
		rect(ctx, "#F9FAFB", x + z, y + 3 * z, 24 * z, 10 * z);
		rect(ctx, "#3B82F6", x + 3 * z, y + 5 * z, 12 * z, z);
		rect(ctx, "#EF4444", x + 3 * z, y + 8 * z, 18 * z, z);
		rect(ctx, "#10B981", x + 3 * z, y + 11 * z, 8 * z, z);
	},
	"neon-sign": (ctx, x, y, z) => {
		rect(ctx, "#1F1B3A", x, y + 3 * z, 24 * z, 10 * z);
		rect(ctx, "#F472B6", x + 2 * z, y + 5 * z, 20 * z, 2 * z);
		rect(ctx, "#22D3EE", x + 2 * z, y + 9 * z, 20 * z, 2 * z);
	},
	plants: (ctx, x, y, z) => {
		rect(ctx, "#16A34A", x + z, y + 2 * z, 8 * z, 6 * z);
		rect(ctx, "#22C55E", x + 3 * z, y, 4 * z, 3 * z);
		rect(ctx, "#B45309", x + 2 * z, y + 8 * z, 6 * z, 6 * z);
	},
	arcade: (ctx, x, y, z) => {
		rect(ctx, "#7C3AED", x, y - 6 * z, 12 * z, 20 * z);
		rect(ctx, "#0F172A", x + 2 * z, y - 4 * z, 8 * z, 6 * z);
		rect(ctx, "#4ADE80", x + 3 * z, y - 3 * z, 3 * z, 2 * z);
		rect(ctx, "#F43F5E", x + 3 * z, y + 4 * z, 2 * z, 2 * z);
		rect(ctx, "#FACC15", x + 7 * z, y + 4 * z, 2 * z, 2 * z);
	},
};

/** Where each piece goes, in tiles: the wall is row 0, the free floor row 1. */
export function decorSpot(
	id: DecorId,
	layout: OfficeLayout,
): { col: number; row: number } {
	const right = Math.max(2, layout.cols - 3);
	switch (id) {
		case "trophy-shelf":
			return { col: 2, row: 0 };
		case "whiteboard":
			return { col: Math.min(5, right), row: 0 };
		case "neon-sign":
			return { col: right, row: 0 };
		case "plants":
			return { col: 1, row: 1 };
		case "arcade":
			return { col: right, row: 1 };
	}
}

export function drawSeasonDecor(
	ctx: CanvasRenderingContext2D,
	layout: OfficeLayout,
	z: number,
	decor: readonly DecorId[],
): void {
	for (const id of decor) {
		const { col, row } = decorSpot(id, layout);
		PAINT[id](ctx, col * TILE_SIZE * z, row * TILE_SIZE * z, z);
	}
}
