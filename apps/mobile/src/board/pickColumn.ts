import type { Column } from "../api/types";
import type { ColumnGroup } from "./columns";

/**
 * The column the board opens on: what waits for a person first (human
 * review), else the first column with a card, else the backlog.
 */
export function initialColumn(groups: readonly ColumnGroup[]): Column {
	const waiting = groups.find((g) => g.column === "human_review" && g.cards.length > 0);
	if (waiting) return waiting.column;
	return groups.find((g) => g.cards.length > 0)?.column ?? "backlog";
}
