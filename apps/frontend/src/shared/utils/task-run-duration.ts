/**
 * How long a task took, measured from its status history
 * (`status_history.json`, `Task.statusHistory`): never estimated.
 *
 * - `agentMs`: the time its agents worked, the time spent in progress or in
 *   AI review, every run added up. A wait in the queue, in human review or in
 *   the backlog does not count.
 * - `leadMs`: from its first launch to the last time it was finished (done, a
 *   pull request opened, or a review that the agents completed).
 *
 * A history that does not show it (a task older than the history, or one
 * never launched) gives `undefined`: the duration is unknown, never 0.
 */
import type { TaskStatusTransition } from "../types/task";

const WORKING: ReadonlySet<string> = new Set(["in_progress", "ai_review"]);

export interface TaskRunDurations {
	agentMs?: number;
	leadMs?: number;
}

function isFinish(entry: TaskStatusTransition): boolean {
	if (entry.to === "done" || entry.to === "pr_created") return true;
	return (
		entry.to === "human_review" &&
		(entry.reason === "completed" || entry.reason === "qa_unverified")
	);
}

function time(entry: TaskStatusTransition | undefined): number | undefined {
	if (!entry) return undefined;
	const at = Date.parse(entry.at);
	return Number.isNaN(at) ? undefined : at;
}

export function taskRunDurations(
	history: readonly TaskStatusTransition[] | undefined,
): TaskRunDurations {
	if (!history || history.length === 0) return {};
	let agentMs = 0;
	let worked = false;
	for (let i = 0; i < history.length; i++) {
		if (!WORKING.has(history[i].to)) continue;
		const start = time(history[i]);
		const end = time(history[i + 1]);
		// A stretch still open (the task is working now) is not counted yet.
		if (start === undefined || end === undefined || end < start) continue;
		agentMs += end - start;
		worked = true;
	}
	const durations: TaskRunDurations = {};
	if (worked) durations.agentMs = agentMs;

	const launchIndex = history.findIndex((entry) => entry.to === "in_progress");
	if (launchIndex >= 0) {
		const launch = time(history[launchIndex]);
		let finish: number | undefined;
		for (let i = history.length - 1; i > launchIndex; i--) {
			if (isFinish(history[i])) {
				finish = time(history[i]);
				break;
			}
		}
		if (launch !== undefined && finish !== undefined && finish >= launch) {
			durations.leadMs = finish - launch;
		}
	}
	return durations;
}

/** A duration in whole units, largest first: the parts an i18n key formats. */
export type DurationParts =
	| { unit: "seconds"; seconds: number }
	| { unit: "minutes"; minutes: number }
	| { unit: "hours"; hours: number; minutes: number }
	| { unit: "days"; days: number; hours: number };

export function durationParts(ms: number): DurationParts {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return { unit: "seconds", seconds };
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return { unit: "minutes", minutes };
	const totalHours = Math.floor(minutes / 60);
	if (totalHours < 24) {
		return { unit: "hours", hours: totalHours, minutes: minutes % 60 };
	}
	return {
		unit: "days",
		days: Math.floor(totalHours / 24),
		hours: totalHours % 24,
	};
}
