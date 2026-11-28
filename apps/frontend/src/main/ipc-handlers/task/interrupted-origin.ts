import type { Task } from "../../../shared/types";
import type { InterruptionOrigin } from "../../../shared/types/interrupted-tasks";
import {
	APP_SHUTDOWN_PAUSE_REASON,
	KILL_SWITCH_PAUSE_REASON,
	VOICE_STOP_PAUSE_REASON,
} from "./pause-state-utils";

/** Persisted statuses in which a task has an agent process behind it. */
const RUNNING_STATUSES = new Set<Task["status"]>(["in_progress", "ai_review"]);

/** Pauses the person asked for, of every agent at once: offered, unticked. */
const STOPPED_BY_YOU = new Set<string>([KILL_SWITCH_PAUSE_REASON, VOICE_STOP_PAUSE_REASON]);

/**
 * How this task's build was interrupted, or null when it was not.
 *
 * A clean close left the shutdown pause (`interrupted-runs.ts`). A crash, a
 * forced kill or an OS shutdown that never delivered `before-quit` left only
 * the status: a task persisted as running, at launch, with no process behind
 * it (or the shutdown pause the launch then settled, `crashed: true`).
 * « Arrêter tous les agents » and « stop » to the voice assistant are the
 * person's own stop. Any other pause (the Pause button, a budget, a policy)
 * is not an interruption. One the person already put off (« Plus tard ») is
 * not offered at launch again, only when they ask from the board
 * (`includeDeferred`).
 */
export function interruptionOrigin(
	task: Task,
	isRunning: (taskId: string) => boolean,
	options: { readonly includeDeferred?: boolean } = {},
): InterruptionOrigin | null {
	if (task.metadata?.archivedAt || task.metadata?.abandoned) return null;
	if (isRunning(task.id)) return null;
	const paused = task.metadata?.paused;
	if (paused?.enabled) {
		if (paused.deferred_at && !options.includeDeferred) return null;
		if (paused.reason === APP_SHUTDOWN_PAUSE_REASON) return paused.crashed ? "crash" : "app_exit";
		if (paused.reason && STOPPED_BY_YOU.has(paused.reason)) return "stopped_by_you";
		return null;
	}
	return RUNNING_STATUSES.has(task.status) ? "crash" : null;
}
