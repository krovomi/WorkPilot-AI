/**
 * How a card reads a build the app interrupted (docs/architecture/pause-resume.md):
 * the shutdown pause `interrupted-runs.ts` wrote when WorkPilot closed, with
 * `crashed` when the next launch found it had stopped without closing.
 */
import type { Task } from "../../shared/types";

export type CardInterruption = "app_exit" | "crash";

/** The reason `interrupted-runs.ts` writes (`APP_SHUTDOWN_PAUSE_REASON` in the main). */
const APP_SHUTDOWN = "app_shutdown";

export function cardInterruption(task: Task): CardInterruption | null {
	const paused = task.metadata?.paused;
	if (!paused?.enabled || paused.reason !== APP_SHUTDOWN) return null;
	if (task.metadata?.archivedAt || task.metadata?.abandoned) return null;
	return paused.crashed ? "crash" : "app_exit";
}

/** The cards of a board the app interrupted, as the banner counts them. */
export function countInterrupted(tasks: readonly Task[]): number {
	return tasks.reduce((n, task) => (cardInterruption(task) ? n + 1 : n), 0);
}
