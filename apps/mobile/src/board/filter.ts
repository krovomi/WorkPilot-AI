/**
 * Finding cards on the board: words typed (in the title, the card's number,
 * who claimed it), the kinds picked, and the person's own cards. Accents and
 * case do not count, so "creer" finds « Créer ».
 */

import type { BoardCard, CardKind } from "../api/types";

export interface BoardFilter {
	query: string;
	kinds: readonly CardKind[];
	mine: boolean;
}

export const NO_FILTER: BoardFilter = { query: "", kinds: [], mine: false };

export function isFiltering(filter: BoardFilter): boolean {
	return filter.query.trim() !== "" || filter.kinds.length > 0 || filter.mine;
}

/** Lower case, without accents. */
function fold(text: string): string {
	return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function matches(card: BoardCard, filter: BoardFilter, userId: string | null): boolean {
	if (filter.mine && (!userId || card.claimedBy !== userId)) return false;
	if (filter.kinds.length > 0 && (!card.kind || !filter.kinds.includes(card.kind))) return false;
	const words = fold(filter.query).split(/\s+/).filter(Boolean);
	if (words.length === 0) return true;
	const number = card.id.split("-")[0];
	const haystack = fold(`${card.title} ${card.id} #${number} ${card.claimedByName ?? ""}`);
	return words.every((word) => haystack.includes(word));
}

export function filterCards(cards: readonly BoardCard[], filter: BoardFilter, userId: string | null): BoardCard[] {
	return isFiltering(filter) ? cards.filter((card) => matches(card, filter, userId)) : [...cards];
}
