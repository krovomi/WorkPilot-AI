/**
 * Task-to-task dependencies.
 *
 * `metadata.blockedBy` holds spec ids of tasks that must finish before this
 * one may be promoted out of `queue`. The board computes the resolved state
 * once per render and publishes it to `kanban-blocker-store`, so a card reads
 * its own entry by id instead of being handed the whole task list.
 *
 * Two rules the queue depends on:
 *
 *  - A blocker id with no matching task is reported as `missing` and does NOT
 *    block. Refusing to promote on an absent signal would let a deleted task
 *    deadlock everything that referenced it — the same call `hard_gates` makes
 *    when a gate has no evidence to judge.
 *  - A task cannot end up blocking itself, directly or transitively.
 *    `wouldCreateCycle` is what the picker uses to keep that out of the data.
 */

import type { Task, TaskStatus } from "../../shared/types";

/** Statuses that count as "this blocker is out of the way". */
const SATISFIED: ReadonlySet<TaskStatus> = new Set(["done", "pr_created"]);

export interface BlockerState {
	/** Blockers that exist and have not finished yet. */
	pending: Task[];
	/** Blockers that exist and are done. */
	resolved: Task[];
	/** Referenced ids with no matching task (deleted). These never block. */
	missing: string[];
}

const EMPTY: BlockerState = { pending: [], resolved: [], missing: [] };

/** Index the board's tasks by id, for the resolvers below. */
export function indexTasksById(tasks: Task[]): Map<string, Task> {
	return new Map(tasks.map((t) => [t.id, t]));
}

/** Split a task's declared blockers into pending / resolved / missing. */
export function resolveBlockers(
	task: Task,
	byId: Map<string, Task>,
): BlockerState {
	const ids = task.metadata?.blockedBy;
	if (!ids || ids.length === 0) return EMPTY;

	const pending: Task[] = [];
	const resolved: Task[] = [];
	const missing: string[] = [];

	for (const id of ids) {
		if (id === task.id) continue; // A task never blocks itself.
		const blocker = byId.get(id);
		if (!blocker) {
			missing.push(id);
		} else if (SATISFIED.has(blocker.status) || blocker.metadata?.archivedAt) {
			resolved.push(blocker);
		} else if (blocker.metadata?.abandoned) {
			// An abandoned blocker is never going to finish; treating it as
			// pending would strand the dependent task with no way forward.
			resolved.push(blocker);
		} else {
			pending.push(blocker);
		}
	}

	return { pending, resolved, missing };
}

/** True when at least one existing blocker has not finished. */
export function isBlocked(task: Task, byId: Map<string, Task>): boolean {
	return resolveBlockers(task, byId).pending.length > 0;
}

/**
 * Would adding `candidateBlockerId` to `taskId`'s blockers close a loop?
 * Walks the existing `blockedBy` edges from the candidate looking for `taskId`.
 */
export function wouldCreateCycle(
	taskId: string,
	candidateBlockerId: string,
	byId: Map<string, Task>,
): boolean {
	if (taskId === candidateBlockerId) return true;

	const seen = new Set<string>();
	const stack = [candidateBlockerId];

	while (stack.length > 0) {
		const current = stack.pop() as string;
		if (current === taskId) return true;
		if (seen.has(current)) continue;
		seen.add(current);

		const blockers = byId.get(current)?.metadata?.blockedBy;
		if (blockers) stack.push(...blockers);
	}

	return false;
}

/**
 * Tasks that may legally be added as a blocker of `task`: everything on the
 * board except itself, archived tasks, and anything that would close a loop.
 */
export function eligibleBlockers(task: Task, tasks: Task[]): Task[] {
	const byId = indexTasksById(tasks);
	const already = new Set(task.metadata?.blockedBy ?? []);
	return tasks.filter(
		(candidate) =>
			candidate.id !== task.id &&
			!already.has(candidate.id) &&
			!candidate.metadata?.archivedAt &&
			!wouldCreateCycle(task.id, candidate.id, byId),
	);
}
