/**
 * Where each card of a selection lands when the selection is dropped on a
 * column, or moved there from the bulk bar. Each card follows the rules of a
 * single drop: a card already there stays, « PR ouverte » takes only a card
 * that has a pull request, and « En cours » takes what its free slots allow;
 * the rest waits in « File d'attente ». Design: docs/architecture/kanban-quick-edit.md.
 */
import { type StatusColumn, TASK_STATUS_COLUMNS, type TaskStatusColumn } from "../../shared/constants/task";
import type { Task, TaskStatus } from "../../shared/types";
import { canMoveTaskTo } from "./kanban-columns";

export interface CardMove {
	readonly task: Task;
	readonly to: TaskStatus;
}

export interface GroupMovePlan {
	readonly moves: readonly CardMove[];
	/** Cards that stay where they are (already there, or not allowed there). */
	readonly skipped: number;
	/** Cards sent to « En cours » that wait in the queue for a free slot. */
	readonly queued: number;
}

/** Cards that take a slot of « En cours ». */
export function countRunning(tasks: readonly Task[]): number {
	return tasks.filter((t) => t.status === "in_progress" && !t.metadata?.archivedAt).length;
}

export function planGroupMove(
	selection: readonly Task[],
	target: StatusColumn,
	freeSlots: number,
): GroupMovePlan {
	const moves: CardMove[] = [];
	let skipped = 0;
	let queued = 0;
	let slots = Math.max(0, freeSlots);
	for (const task of selection) {
		if (!canMoveTaskTo(task, target)) {
			skipped++;
		} else if (target !== "in_progress" || slots > 0) {
			if (target === "in_progress") slots--;
			moves.push({ task, to: target });
		} else {
			queued++;
			if (task.status !== "queue") moves.push({ task, to: "queue" });
		}
	}
	return { moves, skipped, queued };
}

/** The columns that take at least one card of the selection (drop highlight). */
export function groupMoveTargets(selection: readonly Task[]): ReadonlySet<TaskStatusColumn> {
	return new Set(
		TASK_STATUS_COLUMNS.filter((column) =>
			selection.some((task) => canMoveTaskTo(task, column)),
		),
	);
}
