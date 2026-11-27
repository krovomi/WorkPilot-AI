/**
 * The list layout's rows: in the board's order, or sorted by a column with
 * the rows lacking the value last.
 */
import { describe, expect, it } from "vitest";
import type { Sprint, Task } from "../../shared/types";
import { type ListRow, nextListSort, readListSort, rowsOf, sortRows } from "./kanban-list";

/** A card; dates as strings, as a card read back from JSON holds them. */
const card = (id: string, extra: Record<string, unknown> = {}, metadata: Task["metadata"] = {}) =>
	({ id, specId: id, title: `Card ${id}`, status: "backlog", updatedAt: "2026-11-01", metadata, ...extra }) as unknown as Task;

const sprints = [
	{ id: "sp-0000000a", name: "Sprint 12", state: "active", createdAt: "t" },
	{ id: "sp-0000000b", name: "Sprint 13", state: "planned", createdAt: "t" },
] as Sprint[];
const context = { columnOrder: ["backlog", "in_progress", "done"] as const, sprints };
const ids = (rows: ListRow[]) => rows.map((row) => row.task.id);

describe("readListSort", () => {
	it("keeps a known field and direction, and nothing else", () => {
		expect(readListSort({ field: "points", direction: "desc" })).toEqual({ field: "points", direction: "desc" });
		expect(readListSort(null)).toBeNull();
		expect(readListSort("title")).toBeNull();
		expect(readListSort({ field: "assignee", direction: "asc" })).toBeNull();
		expect(readListSort({ field: "title", direction: "up" })).toBeNull();
	});
});

describe("nextListSort", () => {
	it("goes ascending, descending, then back to the board's order", () => {
		const asc = nextListSort(null, "title");
		expect(asc).toEqual({ field: "title", direction: "asc" });
		const desc = nextListSort(asc, "title");
		expect(desc).toEqual({ field: "title", direction: "desc" });
		expect(nextListSort(desc, "title")).toBeNull();
		expect(nextListSort(desc, "points")).toEqual({ field: "points", direction: "asc" });
	});
});

describe("rowsOf", () => {
	it("lists the columns in the board's order, each keeping its own", () => {
		const rows = rowsOf(context.columnOrder, { done: [card("d")], backlog: [card("b1"), card("b2")] });
		expect(rows.map((row) => [row.task.id, row.column])).toEqual([
			["b1", "backlog"],
			["b2", "backlog"],
			["d", "done"],
		]);
	});
});

describe("sortRows", () => {
	const rows: ListRow[] = [
		{ task: card("a", { title: "beta", updatedAt: "2026-11-03" }, { priority: "low", area: "web", sprintId: "sp-0000000b" }), column: "done" },
		{ task: card("b", { title: "Alpha", updatedAt: "not a date" }, { priority: "urgent", sprintId: "sp-0000000f" }), column: "backlog" },
		{ task: card("c", { title: "gamma", updatedAt: "2026-11-02" }, { smartEstimate: { complexityScore: 5 }, area: "API", sprintId: "sp-0000000a" } as Task["metadata"]), column: "in_progress" },
		{ task: card("d", { title: "", updatedAt: "2026-11-02" }, { smartEstimate: { adjustedScore: 8 } } as Task["metadata"]), column: "backlog" },
	];
	const by = (field: Parameters<typeof nextListSort>[1], direction: "asc" | "desc" = "asc") =>
		ids(sortRows(rows, { field, direction }, context));

	it("keeps the board's order without a sort, as a copy", () => {
		const sorted = sortRows(rows, null, context);
		expect(ids(sorted)).toEqual(["a", "b", "c", "d"]);
		expect(sorted).not.toBe(rows);
	});

	it("sorts by each column", () => {
		expect(by("title")).toEqual(["d", "b", "a", "c"]);
		expect(by("status")).toEqual(["b", "d", "c", "a"]);
		expect(by("priority", "desc")).toEqual(["b", "a", "c", "d"]);
		expect(by("sprint")).toEqual(["c", "a", "b", "d"]);
		expect(by("area")).toEqual(["c", "a", "b", "d"]);
		expect(by("points", "desc")).toEqual(["d", "c", "a", "b"]);
		expect(by("updated")).toEqual(["c", "d", "a", "b"]);
	});

	it("puts the rows without the value last, in either direction", () => {
		expect(by("area", "desc")).toEqual(["a", "c", "b", "d"]);
		expect(by("priority")).toEqual(["a", "b", "c", "d"]);
	});

	it("keeps the board's order between equal rows and a status it does not show", () => {
		const twins: ListRow[] = [
			{ task: card("x", {}, { priority: "high" }), column: "abandoned" },
			{ task: card("y", {}, { priority: "high" }), column: "abandoned" },
		];
		expect(ids(sortRows(twins, { field: "priority", direction: "desc" }, context))).toEqual(["x", "y"]);
		expect(ids(sortRows(twins, { field: "status", direction: "asc" }, context))).toEqual(["x", "y"]);
	});
});
