/**
 * Shared progress calculation utilities
 * Used by both main and renderer processes
 */
import { EXECUTION_PHASE_WEIGHTS } from "./constants/task";
import type { Subtask, SubtaskStatus } from "./types";

/**
 * Subtask statuses that count as "done" for progress purposes.
 *
 * Mirrors the backend `core/progress.py::count_subtasks`, which treats both
 * "completed" and "blocked" as done: a blocked subtask (e.g. an e2e test that
 * must be run manually) can't be processed by the agent, so it must not hold the
 * build back nor make a finished build look incomplete (e.g. 2/3 at 67%).
 */
export const DONE_SUBTASK_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"blocked",
]);

/** True when a subtask is "done" (completed or blocked). */
export function isSubtaskDone(status: string): boolean {
	return DONE_SUBTASK_STATUSES.has(status);
}

/**
 * True when the AI pipeline has finished ALL its work for this task, so the
 * progress bar must read 100% regardless of the (possibly stale) in-memory
 * subtask counts.
 *
 * This is why a finished task could show e.g. 50% even with every phase marked
 * "Terminé": the header derives its percent from `task.subtasks`, which can lag
 * behind the on-disk plan (especially after a mid-run LLM hot-swap re-syncs the
 * plan). The task's terminal state is the reliable signal.
 *
 * `human_review` counts ONLY when the review is for a COMPLETED build
 * (`reviewReason === "completed"`) — not a `plan_review` (coding hasn't started),
 * `errors`, or `qa_rejected` hand-off where real work still remains.
 */
export function isTaskEffectivelyComplete(
	status: string | undefined,
	reviewReason?: string,
): boolean {
	if (status === "done" || status === "pr_created") return true;
	if (status === "human_review" && reviewReason === "completed") return true;
	return false;
}

/**
 * Calculate progress percentage from subtasks
 * @param subtasks Array of subtasks with status
 * @returns Progress percentage (0-100)
 */
export function calculateProgress(subtasks: { status: string }[]): number {
	if (subtasks.length === 0) return 0;
	const done = subtasks.filter((c) => isSubtaskDone(c.status)).length;
	return Math.round((done / subtasks.length) * 100);
}

/**
 * Count subtasks by status
 * @param subtasks Array of subtasks
 * @returns Object with counts per status
 */
export function countSubtasksByStatus(
	subtasks: Subtask[],
): Record<SubtaskStatus, number> {
	return {
		pending: subtasks.filter((c) => c.status === "pending").length,
		in_progress: subtasks.filter((c) => c.status === "in_progress").length,
		completed: subtasks.filter((c) => c.status === "completed").length,
		blocked: subtasks.filter((c) => c.status === "blocked").length,
		failed: subtasks.filter((c) => c.status === "failed").length,
	};
}

/**
 * Determine overall status from subtask statuses
 * @param subtasks Array of subtasks
 * @returns Overall status string
 */
export function determineOverallStatus(
	subtasks: { status: string }[],
): "not_started" | "in_progress" | "completed" | "failed" {
	if (subtasks.length === 0) return "not_started";

	const hasDone = subtasks.some((c) => isSubtaskDone(c.status));
	const hasFailed = subtasks.some((c) => c.status === "failed");
	const hasInProgress = subtasks.some((c) => c.status === "in_progress");
	const allDone = subtasks.every((c) => isSubtaskDone(c.status));
	const allPending = subtasks.every((c) => c.status === "pending");

	if (allDone) return "completed";
	if (hasFailed) return "failed";
	if (hasInProgress || hasDone) return "in_progress";
	if (allPending) return "not_started";

	return "in_progress";
}

/**
 * Format progress as display string
 * @param completed Number of completed subtasks
 * @param total Total number of subtasks
 * @returns Formatted string like "3/5 subtasks"
 */
export function formatProgressString(completed: number, total: number): string {
	if (total === 0) return "No subtasks";
	return `${completed}/${total} subtasks`;
}

/**
 * Calculate estimated remaining time based on progress
 * @param startTime Start time of the task
 * @param progress Current progress percentage (0-100)
 * @returns Estimated remaining time in milliseconds, or null if cannot estimate
 */
export function estimateRemainingTime(
	startTime: Date,
	progress: number,
): number | null {
	if (progress <= 0 || progress >= 100) return null;

	const elapsed = Date.now() - startTime.getTime();
	const estimatedTotal = (elapsed / progress) * 100;
	const remaining = estimatedTotal - elapsed;

	return Math.max(0, Math.round(remaining));
}

/**
 * Convert a progress value that is **internal to a phase** (0-100 within the
 * current phase) into the task's **overall** percentage, using that phase's
 * band in `EXECUTION_PHASE_WEIGHTS` (planning 0-20, coding 20-80, QA 80-95…).
 *
 * The two numbers are not interchangeable and used to be shown side by side as
 * if they were: the Kanban card printed the raw `phaseProgress` (15 — "15% of
 * the planning phase") while the detail modal printed `overallProgress` (3 —
 * "3% of the task"), for the same task at the same instant. Only the second one
 * answers "how far along is this task?", so it is the one every surface shows.
 *
 * @returns the overall percentage, or `null` for an unknown phase — the caller
 *   decides whether that is worth reporting.
 */
export function calculateOverallProgress(
	phase: string,
	phaseProgress: number,
): number | null {
	const weight = EXECUTION_PHASE_WEIGHTS[phase];
	if (!weight) return null;

	const clamped = Math.min(100, Math.max(0, phaseProgress));
	const range = weight.end - weight.start;
	return Math.round(weight.start + (range * clamped) / 100);
}

/**
 * The overall percentage carried by an execution-progress record, whatever it
 * actually carries: `overallProgress` when the emitter computed one, otherwise
 * derived from the phase and its internal progress.
 *
 * The fallback is what keeps the card and the modal on the same number when a
 * record predates `overallProgress` (a persisted plan, an older snapshot):
 * without it one surface would read a phase-local number and the other 0%.
 *
 * @returns `undefined` when nothing quantitative is known — distinct from 0%,
 *   which is a real answer ("nothing done yet").
 */
export function resolveOverallProgress(progress?: {
	phase?: string;
	phaseProgress?: number;
	overallProgress?: number;
}): number | undefined {
	if (!progress) return undefined;
	if (typeof progress.overallProgress === "number") {
		return progress.overallProgress;
	}
	if (progress.phase && typeof progress.phaseProgress === "number") {
		return (
			calculateOverallProgress(progress.phase, progress.phaseProgress) ??
			undefined
		);
	}
	return undefined;
}
