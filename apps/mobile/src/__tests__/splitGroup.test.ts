import type { BoardCard } from "../api/types";
import { groupColor, groupTone, inGroup } from "../board/splitGroup";

function card(id: string, group?: BoardCard["group"]): BoardCard {
	return {
		id,
		title: id,
		column: "queue",
		kind: null,
		updatedAt: null,
		subtasks: { completed: 0, total: 0 },
		specId: null,
		claimedBy: null,
		claimedByName: null,
		...(group ? { group } : {}),
	};
}

describe("split group colour", () => {
	// The same fixtures as the desktop (task-split.test.ts) and the backend.
	it.each([
		["012-add-oauth", "green"],
		["001-x", "violet"],
		["abc", "orange"],
		["é-123", "blue"],
		["999-very-long-name-here", "orange"],
		// Three- and four-byte characters, hashed as Python's str.encode("utf-8") does.
		["日本-1", "amber"],
		["€-7", "amber"],
		["🚀-42", "orange"],
	])("%s is %s on every surface", (id, tone) => {
		expect(groupTone(id)).toBe(tone);
	});

	it("takes the charter's light or dark value", () => {
		expect(groupColor("012-add-oauth", false)).toBe("#0f8f6a");
		expect(groupColor("012-add-oauth", true)).toBe("#6fdab4");
	});

	it("shows one group's cards, or every card", () => {
		const group = { id: "012-oauth", title: "OAuth", index: 1, total: 2 };
		const cards = [card("012-oauth-part1", group), card("020-x")];
		expect(inGroup(cards, "012-oauth").map((c) => c.id)).toEqual(["012-oauth-part1"]);
		expect(inGroup(cards, null)).toHaveLength(2);
	});
});
