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
