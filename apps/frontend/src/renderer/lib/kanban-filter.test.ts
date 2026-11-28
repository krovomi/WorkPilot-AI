/**
 * @vitest-environment jsdom
 *
 * One split group shown alone: only its parts match, it counts as a filter,
 * and a second click on the same group shows everything again.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Task } from "../../shared/types";
import { useKanbanFilterStore } from "../stores/kanban-filter-store";
import {
	activeFilterCount,
	EMPTY_FILTERS,
	getTaskSource,
	hasActiveFilters,
	NO_SPRINT,
	TASK_SOURCES,
	taskMatchesFilters,
} from "./kanban-filter";

const part = (id: string, parent: string) =>
	({
		id,
		specId: id,
		title: id,
		description: "",
		metadata: { splitGroup: { parent, index: 1, total: 2 } },
	}) as unknown as Task;
const whole = { id: "020-x", specId: "020-x", title: "x", description: "", metadata: {} } as unknown as Task;

describe("the split group filter", () => {
	it("keeps only the parts of the chosen group", () => {
		const filters = { ...EMPTY_FILTERS, group: "012-oauth" };
		expect(taskMatchesFilters(part("012-oauth-part1", "012-oauth"), filters)).toBe(true);
		expect(taskMatchesFilters(part("030-y-part1", "030-y"), filters)).toBe(false);
		expect(taskMatchesFilters(whole, filters)).toBe(false);
		expect(taskMatchesFilters(whole, EMPTY_FILTERS)).toBe(true);
		expect(hasActiveFilters(filters)).toBe(true);
		expect(activeFilterCount(filters)).toBe(1);
	});

	it("reads a saved view without a group as no constraint", () => {
		const legacy = { search: "", sources: [], categories: [], priorities: [] };
		expect(taskMatchesFilters(whole, legacy)).toBe(true);
		expect(hasActiveFilters(legacy)).toBe(false);
	});
});

describe("toggleGroup", () => {
	beforeEach(() => {
		useKanbanFilterStore.setState({ projectId: null, filters: { ...EMPTY_FILTERS } });
	});

	it("shows one group, then everything again, and clears with the other filters", () => {
		const { toggleGroup, clearFilters } = useKanbanFilterStore.getState();
		toggleGroup("012-oauth");
		expect(useKanbanFilterStore.getState().filters.group).toBe("012-oauth");
		toggleGroup("030-y");
		expect(useKanbanFilterStore.getState().filters.group).toBe("030-y");
		toggleGroup("030-y");
		expect(useKanbanFilterStore.getState().filters.group).toBeUndefined();
		toggleGroup("012-oauth");
		clearFilters();
		expect(useKanbanFilterStore.getState().filters.group).toBeUndefined();
	});
});

describe("the generated source", () => {
	const generated = {
		...whole,
		id: "040-tests",
		metadata: { sourceType: "generated" },
	} as unknown as Task;

	it("gives the cards written by a page their own source", () => {
		expect(TASK_SOURCES).toContain("generated");
		expect(getTaskSource(generated)).toBe("generated");
		expect(getTaskSource(whole)).toBe("manual");
	});

	it("filters on it like any other source", () => {
		const filters = { ...EMPTY_FILTERS, sources: ["generated" as const] };
		expect(taskMatchesFilters(generated, filters)).toBe(true);
		expect(taskMatchesFilters(whole, filters)).toBe(false);
	});
});

describe("the sprint filter", () => {
	const inSprint = { ...whole, id: "s1", metadata: { sprintId: "sp-0000000a" } } as unknown as Task;

	beforeEach(() => {
		useKanbanFilterStore.setState({ projectId: null, filters: { ...EMPTY_FILTERS } });
	});

	it("keeps one sprint's cards, or the backlog's", () => {
		const sprint = { ...EMPTY_FILTERS, sprint: "sp-0000000a" };
		expect(taskMatchesFilters(inSprint, sprint)).toBe(true);
		expect(taskMatchesFilters(whole, sprint)).toBe(false);
		const backlog = { ...EMPTY_FILTERS, sprint: NO_SPRINT };
		expect(taskMatchesFilters(whole, backlog)).toBe(true);
		expect(taskMatchesFilters(inSprint, backlog)).toBe(false);
		expect(activeFilterCount(sprint)).toBe(1);
		expect(hasActiveFilters(sprint)).toBe(true);
	});

	it("is set, replaced and cleared from the store", () => {
		const { setSprint } = useKanbanFilterStore.getState();
		setSprint("sp-0000000a");
		expect(useKanbanFilterStore.getState().filters.sprint).toBe("sp-0000000a");
		setSprint(NO_SPRINT);
		expect(useKanbanFilterStore.getState().filters.sprint).toBe(NO_SPRINT);
		setSprint(undefined);
		expect("sprint" in useKanbanFilterStore.getState().filters).toBe(false);
	});
});

describe("the labels and quick filters", () => {
	const DAY = 86_400_000;
	const now = Date.UTC(2026, 10, 27, 12);
	const card = (metadata: Record<string, unknown>, updatedAt = new Date(now - 2 * DAY)) =>
		({ id: "c", specId: "c", title: "c", description: "", metadata, updatedAt }) as unknown as Task;

	it("keeps the cards with one of the labels, whatever its case", () => {
		const filters = { ...EMPTY_FILTERS, labels: ["Front", "api"] };
		expect(taskMatchesFilters(card({ labels: ["API"] }), filters, now)).toBe(true);
		expect(taskMatchesFilters(card({ labels: ["back"] }), filters, now)).toBe(false);
		expect(taskMatchesFilters(card({}), filters, now)).toBe(false);
		expect(taskMatchesFilters(card({}), { ...EMPTY_FILTERS, labels: [] }, now)).toBe(true);
		expect(hasActiveFilters(filters)).toBe(true);
		expect(activeFilterCount(filters)).toBe(2);
	});

	it("keeps the blocked cards, and those changed in the last seven days", () => {
		const flagged = { ...EMPTY_FILTERS, quick: ["flagged" as const] };
		expect(taskMatchesFilters(card({ flagged: true }), flagged, now)).toBe(true);
		expect(taskMatchesFilters(card({}), flagged, now)).toBe(false);

		const recent = { ...EMPTY_FILTERS, quick: ["recent" as const] };
		expect(taskMatchesFilters(card({}), recent, now)).toBe(true);
		expect(taskMatchesFilters(card({}, new Date(now - 8 * DAY)), recent, now)).toBe(false);
		expect(taskMatchesFilters(card({}, new Date(Number.NaN)), recent, now)).toBe(false);
		expect(taskMatchesFilters(card({}, new Date()), recent)).toBe(true);

		const mine = { ...EMPTY_FILTERS, quick: ["mine" as const] };
		expect(taskMatchesFilters(card({}), { ...mine, claimedByMe: new Set(["c"]) }, now)).toBe(true);
		expect(taskMatchesFilters(card({}), { ...mine, claimedByMe: new Set(["other"]) }, now)).toBe(false);
		expect(taskMatchesFilters(card({}), mine, now)).toBe(false);

		const both = { ...EMPTY_FILTERS, quick: ["flagged" as const, "recent" as const] };
		expect(activeFilterCount(both)).toBe(2);
		expect(hasActiveFilters({ ...EMPTY_FILTERS, quick: [] })).toBe(false);
		expect(hasActiveFilters(both)).toBe(true);
	});
});
