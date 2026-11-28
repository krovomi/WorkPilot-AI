/**
 * Where each task status sits on the Kanban, and where a person may move it.
 *
 * Shared by the board (drag-and-drop, bulk moves), the task navigation and the
 * "Move to" menus, so the rules stay the same everywhere.
 */
import {
	isOutcomeColumn,
	type StatusColumn,
	TASK_STATUS_COLUMNS,
	type TaskStatusColumn,
} from "../../shared/constants/task";
import type { ReviewReason, Task, TaskStatus } from "../../shared/types";

/**
 * The column a status is drawn in, for a task that is not abandoned. Every
 * status has its own column except `error`, drawn in « Échec ».
 */
export function getVisualColumn(status: TaskStatus): TaskStatusColumn {
	if (status === "error") return "failed";
	return status;
}

/**
 * Reviews that mean the run ended badly: subtasks failed, the context grew
 * past the model, or QA still rejected the work after its fixes. They wait in
 * « Échec » instead of « Révision humaine », which keeps the work to approve.
 */
export const FAILED_REVIEW_REASONS: ReadonlySet<ReviewReason> = new Set([
	"errors",
	"prompt_too_long",
	"qa_rejected",
]);

/** Where a failed run can be sent by hand: back to work. */
const RETRY_COLUMNS: ReadonlySet<TaskStatusColumn> = new Set(["backlog", "queue", "in_progress"]);

/** What the column rules read from a task. */
export interface MovableTask {
	readonly status: TaskStatus;
	readonly reviewReason?: ReviewReason;
	readonly metadata?: { readonly prUrl?: string; readonly abandoned?: boolean };
}

/**
 * The column a task is drawn in: « Abandonnée » while it is set aside,
 * « Échec » when its run failed, otherwise its status column.
 */
export function getBoardColumn(task: MovableTask): TaskStatusColumn {
	if (task.metadata?.abandoned === true) return "abandoned";
	if (
		task.status === "human_review" &&
		task.reviewReason &&
		FAILED_REVIEW_REASONS.has(task.reviewReason)
	) {
		return "failed";
	}
	return getVisualColumn(task.status);
}

/**
 * The columns a person creates cards in (quick add, the "+" of the header).
 * A card created in « En cours » starts at once, or waits in the queue when
 * every slot is taken. The others are agent, CI or pull-request phases: a
 * card created there would describe nothing real.
 */
export const QUICK_ADD_COLUMNS = ["backlog", "queue", "in_progress"] as const;
export type QuickAddColumn = (typeof QUICK_ADD_COLUMNS)[number];

export function isQuickAddColumn(status: string): status is QuickAddColumn {
	return (QUICK_ADD_COLUMNS as readonly string[]).includes(status);
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
	// A failed run is sent back to work; an abandoned task is resumed one by one.
	failed: ["queue", "in_progress"],
	abandoned: [],
};

/**
 * Whether a person may move this task to that column by hand.
 *
 * « Échec » is filled by the runs alone, and a task leaves it to be worked on
 * again. « Abandonnée » takes any task but a finished one, and the move asks
 * for a reason. A task leaves « Abandonnée »
 * for any status column, its own included (it is resumed there). « PR
 * ouverte » only takes a card that has a pull request: the column says one is
 * waiting to be merged, so a card without one would lie there.
 */
export function canMoveTaskTo(
	task: MovableTask,
	column: TaskStatusColumn,
): boolean {
	const from = getBoardColumn(task);
	if (from === column || column === "failed") return false;
	if (column === "abandoned") return task.status !== "done";
	// A failed run goes back to work (or is abandoned, above).
	if (from === "failed") return RETRY_COLUMNS.has(column);
	if (task.metadata?.abandoned !== true && task.status === column) return false;
	if (column === "pr_created") return Boolean(task.metadata?.prUrl);
	return true;
}

/**
 * The status columns offered by a "Move to" menu for this task, in board
 * order. Abandoning has its own action (it asks for a reason) and an abandoned
 * task is resumed from its card, so neither shows here.
 */
export function manualMoveTargets(task: MovableTask): StatusColumn[] {
	if (task.metadata?.abandoned === true) return [];
	return TASK_STATUS_COLUMNS.filter(
		(column): column is StatusColumn =>
			!isOutcomeColumn(column) && canMoveTaskTo(task, column),
	);
}
