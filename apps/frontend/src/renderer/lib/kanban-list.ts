/**
 * The board as a list (Jira's list view): one row per card, in the board's
 * order, or sorted by one of the list's columns. Pure helpers, rendered by
 * `components/kanban/BoardList.tsx`.
 *
 * Design: docs/architecture/kanban-list-view.md.
 */
import type { TaskStatusColumn } from "../../shared/constants/task";
import type { Sprint, Task } from "../../shared/types";
import { taskPoints } from "../../shared/utils/sprints";
import { PRIORITY_WEIGHT } from "./kanban-filter";

/** How the board is shown: its columns, or a list of its cards. */
export type BoardLayout = "board" | "list";
export const BOARD_LAYOUTS: readonly BoardLayout[] = ["board", "list"];

/** A list column the rows can be sorted by. */
export type ListSortField = "title" | "status" | "priority" | "sprint" | "area" | "points" | "updated";
export const LIST_SORT_FIELDS: readonly ListSortField[] = [
	"title",
	"status",
	"priority",
	"sprint",
	"area",
	"points",
	"updated",
];

export interface ListSort {
	field: ListSortField;
	direction: "asc" | "desc";
}

/** A row: the card and the board column it sits in. */
export interface ListRow {
	task: Task;
	column: TaskStatusColumn;
}

/** A list sort read back from storage, or null (the board's order). */
export function readListSort(raw: unknown): ListSort | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	if (!LIST_SORT_FIELDS.includes(value.field as ListSortField)) return null;
	if (value.direction !== "asc" && value.direction !== "desc") return null;
	return { field: value.field as ListSortField, direction: value.direction };
}

/** The next sort when a column's header is pressed: ascending, descending, then the board's order. */
export function nextListSort(current: ListSort | null, field: ListSortField): ListSort | null {
	if (current?.field !== field) return { field, direction: "asc" };
	return current.direction === "asc" ? { field, direction: "desc" } : null;
}

/** The rows of some board columns, column after column, each in the board's order. */
export function rowsOf(
	columnOrder: readonly TaskStatusColumn[],
	columns: Partial<Record<TaskStatusColumn, Task[]>>,
): ListRow[] {
	return columnOrder.flatMap((column) => (columns[column] ?? []).map((task) => ({ task, column })));
}

/**
 * The rows sorted by a column. A row without the value comes last, whatever
 * the direction; equal rows keep the board's order.
 */
export function sortRows(
	rows: readonly ListRow[],
	sort: ListSort | null,
	context: { columnOrder: readonly TaskStatusColumn[]; sprints: readonly Sprint[] },
): ListRow[] {
	if (!sort) return [...rows];
	const columnRank = new Map(context.columnOrder.map((column, index) => [column, index]));
	const sprintRank = new Map(context.sprints.map((sprint, index) => [sprint.id, index]));
	const sortValue = (row: ListRow): number | string | null => {
		const metadata = row.task.metadata;
		switch (sort.field) {
			case "title":
				return (row.task.title || "").toLocaleLowerCase();
			case "status":
				return columnRank.get(row.column) ?? null;
			case "priority":
				return metadata?.priority ? PRIORITY_WEIGHT[metadata.priority] : null;
			case "sprint":
				return metadata?.sprintId ? (sprintRank.get(metadata.sprintId) ?? context.sprints.length) : null;
			case "area":
				return metadata?.area ? metadata.area.toLocaleLowerCase() : null;
			case "points":
				return taskPoints(row.task) || null;
			case "updated": {
				const time = new Date(row.task.updatedAt).getTime();
				return Number.isNaN(time) ? null : time;
			}
		}
	};
	const sign = sort.direction === "asc" ? 1 : -1;
	return rows
		.map((row, index) => ({ row, index, value: sortValue(row) }))
		.sort((a, b) => {
			if (a.value === null || b.value === null) {
				return a.value === b.value ? a.index - b.index : a.value === null ? 1 : -1;
			}
			const order =
				typeof a.value === "number" && typeof b.value === "number"
					? a.value - b.value
					: String(a.value).localeCompare(String(b.value));
			return order === 0 ? a.index - b.index : sign * order;
		})
		.map((item) => item.row);
}
