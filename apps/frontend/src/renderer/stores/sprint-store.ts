/**
 * The sprints of the open project's Kanban. The main process keeps them (a
 * local project's `.workpilot/sprints.json`, or the server for a server
 * project) and answers every change with the project's sprints as they now
 * are; this store holds that answer for the board, its menus and lanes.
 *
 * Starting a sprint records what it holds; closing it counts what was done,
 * moves the unfinished cards to a planned sprint or back to the backlog,
 * then records the report. Deleting a planned sprint sends its cards back to
 * the backlog first.
 *
 * Design: docs/architecture/kanban-sprints.md.
 */
import { create } from "zustand";
import type { Sprint, SprintDraft, SprintReport, Task } from "../../shared/types";
import { isTaskDone, sprintProgress, taskPoints } from "../../shared/utils/sprints";
import { persistUpdateTask, useTaskStore } from "./task-store";

/** What a change answered: done, or why not (the main process's error code or message). */
export type SprintOutcome = { ok: true } | { ok: false; error: string; failedCards?: number };

interface SprintState {
	projectId: string | null;
	sprints: Sprint[];
	loading: boolean;
	/** Read the project's sprints (again). */
	load: (projectId: string) => Promise<void>;
	save: (draft: SprintDraft) => Promise<SprintOutcome>;
	start: (sprintId: string) => Promise<SprintOutcome>;
	/** Close the active sprint; its unfinished cards go to `carryTo` (a planned sprint) or the backlog (null). */
	complete: (sprintId: string, carryTo: string | null) => Promise<SprintOutcome>;
	remove: (sprintId: string) => Promise<SprintOutcome>;
}

function api() {
	return globalThis.electronAPI;
}

function tasksOf(sprintId: string): Task[] {
	return useTaskStore.getState().tasks.filter((task) => task.metadata?.sprintId === sprintId);
}

/** Moves cards to another sprint (or none); resolves how many could not be saved. */
async function moveCards(tasks: readonly Task[], sprintId: string | undefined): Promise<number> {
	let failed = 0;
	for (const task of tasks) {
		if (!(await persistUpdateTask(task.id, { metadata: { sprintId } }))) failed++;
	}
	return failed;
}

/** What a closing sprint did, counted on the board before its cards move on. */
export function sprintReport(tasks: readonly Task[], sprintId: string, carryTo: string | null): SprintReport {
	const progress = sprintProgress(tasks, sprintId);
	const carried = tasks.filter((task) => task.metadata?.sprintId === sprintId && !isTaskDone(task));
	return {
		done: progress.done,
		donePoints: progress.donePoints,
		carried: carried.length,
		carriedPoints: carried.reduce((sum, task) => sum + taskPoints(task), 0),
		carriedTo: carryTo,
	};
}

export const useSprintStore = create<SprintState>((set, get) => {
	/** Applies a main-process answer for the project it was asked for. */
	const answer = async (
		call: (projectId: string) => Promise<{ success: boolean; data?: Sprint[]; error?: string }> | undefined,
	): Promise<SprintOutcome> => {
		const projectId = get().projectId;
		if (!projectId) return { ok: false, error: "no_project" };
		try {
			const result = await call(projectId);
			if (!result) return { ok: false, error: "unavailable" };
			if (!result.success || !result.data) return { ok: false, error: result.error ?? "unknown" };
			if (get().projectId === projectId) set({ sprints: result.data });
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : "unknown" };
		}
	};

	return {
		projectId: null,
		sprints: [],
		loading: false,

		load: async (projectId) => {
			if (get().projectId !== projectId) set({ projectId, sprints: [] });
			set({ loading: true });
			try {
				const result = await api()?.listSprints?.(projectId);
				if (get().projectId === projectId && result?.success && result.data) {
					set({ sprints: result.data });
				}
			} catch {
				// Unreadable sprints: the board still works without them.
			} finally {
				if (get().projectId === projectId) set({ loading: false });
			}
		},

		save: (draft) => answer((projectId) => api()?.saveSprint?.(projectId, draft)),

		start: (sprintId) => {
			const progress = sprintProgress(useTaskStore.getState().tasks, sprintId);
			return answer((projectId) =>
				api()?.startSprint?.(projectId, sprintId, { cards: progress.cards, points: progress.points }),
			);
		},

		complete: async (sprintId, carryTo) => {
			const tasks = useTaskStore.getState().tasks;
			const report = sprintReport(tasks, sprintId, carryTo);
			const unfinished = tasksOf(sprintId).filter((task) => !isTaskDone(task));
			const failedCards = await moveCards(unfinished, carryTo ?? undefined);
			if (failedCards > 0) return { ok: false, error: "cards_not_moved", failedCards };
			return answer((projectId) => api()?.completeSprint?.(projectId, sprintId, report));
		},

		remove: async (sprintId) => {
			const failedCards = await moveCards(tasksOf(sprintId), undefined);
			if (failedCards > 0) return { ok: false, error: "cards_not_moved", failedCards };
			return answer((projectId) => api()?.deleteSprint?.(projectId, sprintId));
		},
	};
});
