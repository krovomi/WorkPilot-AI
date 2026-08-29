/**
 * Queue promotion order.
 *
 * `processQueue` promotes tickets out of the `queue` column whenever a slot
 * frees up. It used to pick the oldest one, which meant an urgent ticket
 * created this morning waited behind a low-priority one filed last week —
 * while the project's own rule is to order by priority, not by duration
 * estimates.
 *
 * Priority decides first, `createdAt` breaks the tie. A ticket with no
 * priority set weighs less than every explicit one, so a board where nobody
 * ever sets a priority keeps the exact FIFO behaviour it had before.
 */

import type { Task } from "../../shared/types";
import { PRIORITY_WEIGHT } from "./kanban-filter";

/** Weight of a task's priority; 0 when unset, i.e. below every explicit level. */
function priorityWeight(task: Task): number {
	const priority = task.metadata?.priority;
	return priority ? (PRIORITY_WEIGHT[priority] ?? 0) : 0;
}

/** Epoch ms of a task's creation, tolerant of string dates coming from IPC. */
function createdAtMs(task: Task): number {
	const ms = new Date(task.createdAt).getTime();
	return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Comparator for queue promotion: most urgent first, oldest first within a
 * priority band.
 */
export function compareQueueOrder(a: Task, b: Task): number {
	const byPriority = priorityWeight(b) - priorityWeight(a);
	if (byPriority !== 0) return byPriority;
	return createdAtMs(a) - createdAtMs(b);
}

/** Copy of `tasks` in promotion order. Does not mutate the input. */
export function orderQueue(tasks: Task[]): Task[] {
	return [...tasks].sort(compareQueueOrder);
}
