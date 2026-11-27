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
	"failed",
	"build_failed",
	"pr_created",
	"done",
	"abandoned",
];

/** Columns shown even when empty; the others appear only with a card. */
const ALWAYS_SHOWN = new Set<Column>(["backlog", "in_progress", "ai_review", "human_review", "done"]);

export interface ColumnGroup {
	column: Column;
	cards: BoardCard[];
}

/**
 * The column the desktop draws a card in: « Échec » for a run that ended
 * badly (an error included, on an older server too), « Abandonnée » for a card
 * set aside, otherwise its plan's column.
 */
export function boardColumn(card: Pick<BoardCard, "column" | "outcome">): Column {
	if (card.outcome) return card.outcome;
	return card.column === "error" ? "failed" : card.column;
}

/** The cards under their column, in board order; a card of an unknown column goes to backlog. */
export function groupByColumn(cards: readonly BoardCard[]): ColumnGroup[] {
	const groups = COLUMN_ORDER.map((column) => ({ column, cards: [] as BoardCard[] }));
	const backlog = groups[0]; // COLUMN_ORDER starts with it
	for (const card of cards) {
		const column = boardColumn(card);
		(groups.find((g) => g.column === column) ?? backlog).cards.push(card);
	}
	return groups.filter((g) => ALWAYS_SHOWN.has(g.column) || g.cards.length > 0);
}

/** Columns where an agent is at work on the card. */
export const ACTIVE_COLUMNS = new Set<Column>(["queue", "in_progress", "ai_review"]);
