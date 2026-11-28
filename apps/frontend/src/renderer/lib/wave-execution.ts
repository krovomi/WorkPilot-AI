/**
 * "Execute in optimal order" (#358): which tasks of the current wave to start
 * now, and when to move to the next wave. Pure; the store runs it on every
 * task change and starts tasks through `persistTaskStatus(id, "in_progress")`,
 * the path the queue uses — so each task runs with its own provider.
 *
 * A wave's tasks stay in the backlog until there is room (the project's max
 * parallel tasks), so the board's queue never promotes them out of order.
 */

import type { Task, TaskStatus } from "../../shared/types";
import type { WaveAdvanceWhen, WaveRunState } from "../../shared/types/conflict-waves";
import { indexTasksById, isBlocked } from "./kanban-dependencies";

/**
 * A run in memory: the state saved in the project after every step
 * (`WaveRunState`, so it survives a restart) and whether it still runs.
 */
export interface WaveExecution extends WaveRunState {
	status: "running" | "done" | "stopped";
}

export interface WaveStep {
	/** Tasks to start now, in order. */
	promote: string[];
	/** Tasks of the wave held back by a dependency not finished yet. */
	blocked: string[];
	/** Every task of the current wave is settled. */
	waveSettled: boolean;
	/** ...and it was the last wave. */
	finished: boolean;
}

/** `merged`: the next wave starts from a base that holds this one. */
const SETTLED: Record<WaveAdvanceWhen, ReadonlySet<TaskStatus>> = {
	merged: new Set(["done"]),
	review: new Set(["human_review", "pr_created", "done", "error", "build_failed"]),
};

const NOT_STARTED: ReadonlySet<TaskStatus> = new Set(["backlog", "queue"]);

function isSettled(task: Task, execution: WaveExecution): boolean {
	if (task.metadata?.archivedAt || task.metadata?.abandoned) return true;
	if (SETTLED[execution.advanceWhen].has(task.status)) return true;
	// Started by this execution, then put back in the backlog by the person
	// (or refused by the start path): it has left the plan, do not wait on it.
	return task.status === "backlog" && execution.started.includes(task.id);
}

export function stepWaveExecution(
	execution: WaveExecution,
	tasks: readonly Task[],
): WaveStep {
	const idle: WaveStep = { promote: [], blocked: [], waveSettled: false, finished: false };
	if (execution.status !== "running") return idle;
	const wave = execution.waves[execution.current];
	if (!wave) return { ...idle, waveSettled: true, finished: true };

	const projectTasks = tasks.filter((t) => t.projectId === execution.projectId);
	// The board shows another project: nothing to judge, wait for it to return.
	if (projectTasks.length === 0) return idle;
	const byId = indexTasksById(projectTasks);
	const members = wave.map((id) => byId.get(id)).filter((t): t is Task => t !== undefined);

	if (members.every((t) => isSettled(t, execution))) {
		return {
			...idle,
			waveSettled: true,
			finished: execution.current >= execution.waves.length - 1,
		};
	}

	const running = projectTasks.filter(
		(t) => t.status === "in_progress" && !t.metadata?.archivedAt,
	).length;
	let room = Math.max(0, Math.floor(execution.maxParallel) - running);
	const promote: string[] = [];
	const blocked: string[] = [];
	for (const task of members) {
		if (!NOT_STARTED.has(task.status) || execution.started.includes(task.id)) continue;
		if (isBlocked(task, byId)) {
			blocked.push(task.id);
			continue;
		}
		if (room > 0) {
			promote.push(task.id);
			room--;
		}
	}
	return { promote, blocked, waveSettled: false, finished: false };
}
