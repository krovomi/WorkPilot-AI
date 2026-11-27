/**
 * « Bloquée »: a task a person flagged as impeded (Jira's flag), and a task
 * the board finds blocked by itself (a blocker not finished, a pause).
 *
 * The flag is metadata only, like an abandon: the task keeps its status and
 * its column. Design: docs/architecture/kanban-outcome-columns.md.
 */
import type { Task, TaskMetadata } from "../types/task";

/** The longest reason kept; the server refuses more (`shared_board/settings.py`). */
export const MAX_FLAG_REASON = 500;

export function isTaskFlagged(task: Pick<Task, "metadata">): boolean {
	return task.metadata?.flagged === true;
}

/** Metadata patch that flags a task; a blank reason is left out. */
export function buildFlagMetadata(reason = "", now: Date = new Date()): Partial<TaskMetadata> {
	const trimmed = reason.trim().slice(0, MAX_FLAG_REASON);
	return {
		flagged: true,
		flaggedAt: now.toISOString(),
		flaggedReason: trimmed || undefined,
	};
}

/** Metadata patch that lifts the flag. */
export function buildUnflagMetadata(): Partial<TaskMetadata> {
	return { flagged: false, flaggedReason: undefined, flaggedAt: undefined };
}

/** Why a task cannot move on: flagged, paused, or waiting for unfinished blockers. */
export type BlockedReason = "flagged" | "paused" | "blockers";

export function blockedReasons(
	task: Pick<Task, "metadata">,
	pendingBlockers = 0,
): BlockedReason[] {
	const reasons: BlockedReason[] = [];
	if (isTaskFlagged(task)) reasons.push("flagged");
	if (task.metadata?.paused?.enabled === true) reasons.push("paused");
	if (pendingBlockers > 0) reasons.push("blockers");
	return reasons;
}
