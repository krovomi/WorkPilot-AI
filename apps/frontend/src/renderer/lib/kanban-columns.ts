/**
 * Where each task status sits on the Kanban, and where a person may move it.
 *
 * Shared by the board (drag-and-drop, bulk moves), the task navigation and the
 * "Move to" menus, so the rules stay the same everywhere.
 */
import {
	TASK_STATUS_COLUMNS,
	type TaskStatusColumn,
} from "../../shared/constants/task";
import type { Task, TaskStatus } from "../../shared/types";

/**
 * The column a status is drawn in. Every status has its own column except
 * `error`, shown under « Révision humaine » because an error needs a person.
 */
export function getVisualColumn(status: TaskStatus): TaskStatusColumn {
	if (status === "error") return "human_review";
	return status;
}

/** One empty list per column, in board order. */
export function emptyColumnGroups(): Record<TaskStatusColumn, Task[]> {
	return Object.fromEntries(
		TASK_STATUS_COLUMNS.map((column) => [column, [] as Task[]]),
	) as Record<TaskStatusColumn, Task[]>;
}

/**
 * Target columns of a bulk drag (multi-selection), by the selection's column.
 * Mirrors the bulk action bar.
 */
export const VALID_BULK_TRANSITIONS: Record<
	TaskStatusColumn,
	TaskStatusColumn[]
> = {
	backlog: ["queue", "in_progress"],
	queue: ["backlog", "in_progress"],
	in_progress: ["queue", "ai_review"],
	ai_review: ["in_progress", "human_review"],
	human_review: ["ai_review", "done"],
	// build_failed is CI-driven: tasks land there when the pipeline goes red;
	// from there the user can only send them back to work manually.
	build_failed: ["queue", "in_progress"],
	// An open PR is closed by its merge (worktree-purge/merged-watch.ts); a
	// person may still mark it done by hand.
	pr_created: ["done"],
	done: [],
};

/** What the move rules read from a task. */
export interface MovableTask {
	readonly status: TaskStatus;
	readonly metadata?: { readonly prUrl?: string };
}

/**
 * Whether a person may move this task to that column by hand. « PR ouverte »
 * only takes a card that has a pull request: the column says one is waiting
 * to be merged, so a card without one would lie there.
 */
export function canMoveTaskTo(
	task: MovableTask,
	column: TaskStatusColumn,
): boolean {
	if (task.status === column) return false;
	if (column === "pr_created") return Boolean(task.metadata?.prUrl);
	return true;
}

/** The columns offered by a "Move to" menu for this task, in board order. */
export function manualMoveTargets(
	task: MovableTask,
): TaskStatusColumn[] {
	return TASK_STATUS_COLUMNS.filter((column) => canMoveTaskTo(task, column));
}
