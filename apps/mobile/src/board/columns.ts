/**
 * The board's columns, in the order the desktop Kanban draws them, and the
 * cards grouped under them.
 */

import type { BoardCard, Column } from "../api/types";

export const COLUMN_ORDER: readonly Column[] = [
	"backlog",
	"queue",
	"in_progress",
	"ai_review",
	"human_review",
	"build_failed",
	"pr_created",
	"done",
	"error",
];

/** Columns shown even when empty; the others appear only with a card. */
const ALWAYS_SHOWN = new Set<Column>(["backlog", "in_progress", "ai_review", "human_review", "done"]);

export interface ColumnGroup {
	column: Column;
	cards: BoardCard[];
}

/** The cards under their column, in board order; a card of an unknown column goes to backlog. */
export function groupByColumn(cards: readonly BoardCard[]): ColumnGroup[] {
	const groups = new Map<Column, BoardCard[]>(COLUMN_ORDER.map((c) => [c, []]));
	for (const card of cards) {
		const target = groups.get(card.column) ?? groups.get("backlog");
		target?.push(card);
	}
	return COLUMN_ORDER.filter((c) => ALWAYS_SHOWN.has(c) || (groups.get(c)?.length ?? 0) > 0).map((column) => ({
		column,
		cards: groups.get(column) ?? [],
	}));
}

/** Columns where an agent is at work on the card. */
export const ACTIVE_COLUMNS = new Set<Column>(["queue", "in_progress", "ai_review"]);
