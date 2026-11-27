import type { BoardCard } from "../api/types";
import { filterCards, isFiltering, matches, NO_FILTER } from "../board/filter";

const card = (over: Partial<BoardCard> = {}): BoardCard => ({
	id: "012-search",
	title: "Écrire la recherche",
	column: "backlog",
	kind: "feature",
	updatedAt: null,
	subtasks: { completed: 0, total: 0 },
	specId: null,
	claimedBy: null,
	claimedByName: null,
	...over,
});

describe("board filter", () => {
	it("is off until a word, a kind or the person's own cards are asked", () => {
		expect(isFiltering(NO_FILTER)).toBe(false);
		expect(isFiltering({ ...NO_FILTER, query: "  " })).toBe(false);
		expect(isFiltering({ ...NO_FILTER, query: "x" })).toBe(true);
		expect(isFiltering({ ...NO_FILTER, kinds: ["docs"] })).toBe(true);
		expect(isFiltering({ ...NO_FILTER, mine: true })).toBe(true);
	});

	it("finds every word typed, without accents or case", () => {
		expect(matches(card(), { ...NO_FILTER, query: "ECRIRE recherche" }, null)).toBe(true);
		expect(matches(card(), { ...NO_FILTER, query: "#012" }, null)).toBe(true);
		expect(matches(card(), { ...NO_FILTER, query: "ecrire tests" }, null)).toBe(false);
		expect(matches(card({ claimedByName: "Zoé" }), { ...NO_FILTER, query: "zoe" }, null)).toBe(true);
	});

	it("keeps the kinds picked, and the person's own cards once they are known", () => {
		expect(matches(card(), { ...NO_FILTER, kinds: ["docs"] }, null)).toBe(false);
		expect(matches(card({ kind: null }), { ...NO_FILTER, kinds: ["feature"] }, null)).toBe(false);
		expect(matches(card(), { ...NO_FILTER, kinds: ["docs", "feature"] }, null)).toBe(true);
		expect(matches(card({ claimedBy: "u1" }), { ...NO_FILTER, mine: true }, "u1")).toBe(true);
		expect(matches(card({ claimedBy: "u2" }), { ...NO_FILTER, mine: true }, "u1")).toBe(false);
		expect(matches(card({ claimedBy: null }), { ...NO_FILTER, mine: true }, null)).toBe(false);
	});

	it("gives a new list either way", () => {
		const cards = [card(), card({ id: "013-x", title: "Other" })];
		const all = filterCards(cards, NO_FILTER, null);
		expect(all).toEqual(cards);
		expect(all).not.toBe(cards);
		expect(filterCards(cards, { ...NO_FILTER, query: "other" }, null).map((c) => c.id)).toEqual(["013-x"]);
	});
});
