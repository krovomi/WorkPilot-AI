/**
 * Narrowing and ordering the PR list: search, authors, review statuses
 * (as the list labels them) and the sort the reset keeps.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PRData } from "../../../../../preload/api/modules/github-api";
import type { PRReviewInfo } from "../../utils/pr-review-status";
import { usePRFiltering } from "../usePRFiltering";

const pr = (number: number, fields: Partial<PRData> = {}) =>
	({
		number,
		title: `PR ${number}`,
		body: "",
		author: { login: "ana" },
		additions: 1,
		deletions: 1,
		createdAt: `2026-11-0${number}T00:00:00Z`,
		...fields,
	}) as PRData;

const PRS = [
	pr(1, { title: "Fix login", author: { login: "Bob" } }),
	pr(2, { body: "Touches the LOGIN page", additions: 50 }),
	pr(3, { author: { login: "ana" }, deletions: 50 }),
	pr(4, { author: null as never }),
];

const STATES: Record<number, PRReviewInfo> = {
	1: { isReviewing: true, result: null },
	// The list shows this one as "Ready to Merge": some findings were posted.
	2: { isReviewing: false, result: { findings: [], postedFindingIds: ["x"] } as never },
	3: { isReviewing: false, result: { findings: [] } as never },
};

function setup(prs = PRS) {
	return renderHook(() => usePRFiltering(prs, (n) => STATES[n] ?? null));
}
const numbers = (r: ReturnType<typeof setup>) =>
	r.result.current.filteredPRs.map((p) => p.number);

describe("usePRFiltering", () => {
	it("lists the authors once each, in name order", () => {
		const r = setup([...PRS, pr(5, { author: { login: "carl" } })]);
		expect(r.result.current.contributors).toEqual(["ana", "Bob", "carl"]);
	});

	it("shows the newest first, everything when nothing filters", () => {
		const r = setup();
		expect(numbers(r)).toEqual([4, 3, 2, 1]);
		expect(r.result.current.hasActiveFilters).toBe(false);
	});

	it("searches titles, bodies and numbers", () => {
		const r = setup();
		act(() => r.result.current.setSearchQuery("login"));
		expect(numbers(r)).toEqual([2, 1]);
		act(() => r.result.current.setSearchQuery("3"));
		expect(numbers(r)).toEqual([3]);
		expect(r.result.current.hasActiveFilters).toBe(true);
	});

	it("keeps the chosen authors' PRs, never one without an author", () => {
		const r = setup();
		act(() => r.result.current.setContributors(["Bob", "ana"]));
		expect(numbers(r)).toEqual([3, 2, 1]);
	});

	it("filters on the status the list shows", () => {
		const r = setup();
		act(() => r.result.current.setStatuses(["ready_to_merge"]));
		expect(numbers(r)).toEqual([2]);
		act(() => r.result.current.setStatuses(["posted"]));
		expect(numbers(r)).toEqual([2]);
		act(() => r.result.current.setStatuses(["reviewing", "not_reviewed"]));
		expect(numbers(r)).toEqual([4, 1]);
		act(() => r.result.current.setStatuses(["reviewed"]));
		expect(numbers(r)).toEqual([3]);
	});

	it("sorts oldest first or by size, and keeps the sort on reset", () => {
		const r = setup();
		act(() => r.result.current.setSortBy("oldest"));
		expect(numbers(r)).toEqual([1, 2, 3, 4]);
		act(() => r.result.current.setSortBy("largest"));
		// 2 and 3 have the same size: the newest comes first.
		expect(numbers(r)).toEqual([3, 2, 4, 1]);

		act(() => {
			r.result.current.setSearchQuery("PR");
			r.result.current.setStatuses(["reviewed"]);
		});
		act(() => r.result.current.clearFilters());
		expect(r.result.current.filters).toEqual({
			searchQuery: "",
			contributors: [],
			statuses: [],
			sortBy: "largest",
		});
	});

	it("counts a PR without line counts as empty", () => {
		const r = setup([pr(1, { additions: undefined as never, deletions: undefined as never }), pr(2)]);
		act(() => r.result.current.setSortBy("largest"));
		expect(numbers(r)).toEqual([2, 1]);
	});
});
