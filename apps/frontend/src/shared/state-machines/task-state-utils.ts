/**
 * Shared XState task state utilities.
 *
 * Provides type-safe state names, phase mappings, and legacy status conversion
 * derived from the task machine definition. Used by task-state-manager and
 * agent-events-handlers to avoid duplicate constants.
 */
import type { ExecutionPhase, ReviewReason, Task, TaskStatus } from "../types";
import type { TaskEvent } from "./task-machine";

/**
 * All XState task state names.
 *
 * IMPORTANT: These must match the state keys in task-machine.ts.
 * If you add/remove a state in the machine, update this array.
 */
export const TASK_STATE_NAMES = [
	"backlog",
	"planning",
	"plan_review",
	"coding",
	"qa_review",
	"qa_fixing",
	"human_review",
	"error",
	"creating_pr",
	"pr_created",
	"done",
] as const;

export type TaskStateName = (typeof TASK_STATE_NAMES)[number];

/**
 * XState states where the task has "settled" — the state machine has determined
 * the task's final or review status. Execution-progress events from the agent
 * process should NOT overwrite these states, as XState is the source of truth.
 *
 * Note: `error` is included because stale execution-progress events (e.g.,
 * phase='failed') may arrive after XState has already transitioned to error.
 * When a user resumes from error (USER_RESUMED), XState transitions synchronously
 * to `coding` before the new agent process emits events, so the guard no longer
 * blocks — new execution-progress events flow through normally.
 */
export const XSTATE_SETTLED_STATES: ReadonlySet<string> =
	new Set<TaskStateName>([
		"plan_review",
		"human_review",
		"error",
		"creating_pr",
		"pr_created",
		"done",
	]);

/** Maps XState states to execution phases. */
export const XSTATE_TO_PHASE: Record<TaskStateName, ExecutionPhase> &
	Record<string, ExecutionPhase | undefined> = {
	backlog: "idle",
	planning: "planning",
	plan_review: "planning",
	coding: "coding",
	qa_review: "qa_review",
	qa_fixing: "qa_fixing",
	human_review: "complete",
	error: "failed",
	creating_pr: "complete",
	pr_created: "complete",
	done: "complete",
};

/**
 * Convert XState state to legacy status/reviewReason pair.
 *
 * When reviewReason is provided (from XState context), it's used for the
 * human_review state. Otherwise defaults to 'completed' (used by re-stamp
 * callers that don't have access to the XState context).
 */
export function mapStateToLegacy(
	state: string,
	reviewReason?: ReviewReason,
): { status: TaskStatus; reviewReason?: ReviewReason } {
	switch (state) {
		case "backlog":
			return { status: "backlog" };
		case "planning":
		case "coding":
			return { status: "in_progress" };
		case "plan_review":
			return { status: "human_review", reviewReason: "plan_review" };
		case "qa_review":
		case "qa_fixing":
			return { status: "ai_review" };
		case "human_review":
			return {
				status: "human_review",
				reviewReason: reviewReason ?? "completed",
			};
		case "error":
			return { status: "human_review", reviewReason: "errors" };
		case "creating_pr":
			return { status: "human_review", reviewReason: "completed" };
		case "pr_created":
			return { status: "pr_created" };
		case "done":
			return { status: "done" };
		default:
			return { status: "backlog" };
	}
}


/**
 * The event a relaunch owes the machine, or null when it owes it nothing.
 *
 * Starting a task says so (`determineStartEvent`); resuming one used to say
 * nothing at all, and a machine left settled in `human_review`/`error` keeps
 * the review reason and the failure message that go with it. That is the red
 * "this task failed" banner still sitting above a task that is visibly running
 * again, quoting the run it replaced.
 *
 * Which event, when there is one, follows the phase the backend is about to
 * re-enter — it reads the spec directory, so a task with no plan re-plans.
 * USER_RESUMED would settle such a task in `coding`, where PLANNING_STARTED is
 * not handled, and the planning it then does would be reported to nobody.
 *
 * Null for every state that is not settled: a task paused mid-coding is in
 * `coding`, which is where the resumed run belongs, and an event there would
 * either be dropped or move it somewhere it is not.
 */
export function relaunchEventFor(
	currentState: string | undefined,
	task: Pick<Task, "status" | "subtasks"> & {
		metadata?: { paused?: { paused_phase?: string | null } };
	},
): TaskEvent | null {
	const settled =
		currentState === "error" ||
		currentState === "human_review" ||
		(currentState === undefined &&
			(task.status === "error" || task.status === "human_review"));
	if (!settled) return null;

	const pausedPhase = task.metadata?.paused?.paused_phase;
	const replans =
		(task.subtasks?.length ?? 0) === 0 ||
		pausedPhase === "spec" ||
		pausedPhase === "planning";
	return replans ? { type: "PLANNING_STARTED" } : { type: "USER_RESUMED" };
}
