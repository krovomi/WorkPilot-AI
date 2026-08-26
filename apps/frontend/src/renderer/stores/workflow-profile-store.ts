/**
 * Workflow Profile — Zustand store
 *
 * Holds the resolved execution profile for a task: which phases the chosen
 * effort level will run, which it dropped and why, and what each level would
 * cost.
 *
 * Keyed by task id rather than kept in a single slot because the modal can be
 * reopened on a different card while a request for the previous one is still
 * in flight, and because previewing a level fires a second request for the
 * same card. One slot would let a late answer overwrite the card the user is
 * actually looking at — so every request carries its own controller, and a
 * response the store has already superseded is dropped rather than written.
 */

import { create } from "zustand";
import {
	type WorkflowProfilePayload,
	fetchWorkflowProfile,
} from "../lib/agent-tools-api";

export interface WorkflowProfileEntry {
	profile: WorkflowProfilePayload | null;
	loading: boolean;
	error: string | null;
	/** The level being previewed, or null when showing the task's own. */
	previewEffort: string | null;
}

const EMPTY: WorkflowProfileEntry = {
	profile: null,
	loading: false,
	error: null,
	previewEffort: null,
};

export interface LoadWorkflowProfileArgs {
	taskId: string;
	/** Either an absolute spec directory… */
	specDir?: string;
	/** …or the pair that names it. The server owns the layout. */
	projectDir?: string;
	specId?: string;
	provider?: string;
	/** Preview a level without changing the task's configuration. */
	effort?: string;
}

interface WorkflowProfileState {
	byTask: Record<string, WorkflowProfileEntry>;
	load: (args: LoadWorkflowProfileArgs) => Promise<void>;
	clear: (taskId: string) => void;
}

const inFlight = new Map<string, AbortController>();

export const useWorkflowProfileStore = create<WorkflowProfileState>((set) => ({
	byTask: {},

	clear: (taskId) => {
		inFlight.get(taskId)?.abort();
		inFlight.delete(taskId);
		set((state) => {
			if (!(taskId in state.byTask)) return state;
			const next = { ...state.byTask };
			delete next[taskId];
			return { byTask: next };
		});
	},

	load: async ({ taskId, projectDir, specId, specDir, provider, effort }) => {
		if (!specDir && !(projectDir && specId)) return;

		inFlight.get(taskId)?.abort();
		const controller = new AbortController();
		inFlight.set(taskId, controller);

		set((state) => ({
			byTask: {
				...state.byTask,
				[taskId]: {
					...(state.byTask[taskId] ?? EMPTY),
					loading: true,
					error: null,
					previewEffort: effort ?? null,
				},
			},
		}));

		const res = await fetchWorkflowProfile(
			{ projectDir, specId, specDir, provider, effort },
			controller.signal,
		);

		// A request the store has already replaced does not get to answer.
		if (inFlight.get(taskId) !== controller) return;
		inFlight.delete(taskId);
		if (!res.ok && res.error === "aborted") return;

		set((state) => ({
			byTask: {
				...state.byTask,
				[taskId]: {
					...(state.byTask[taskId] ?? EMPTY),
					loading: false,
					profile: res.ok ? res.data.profile : null,
					error: res.ok ? null : res.error,
				},
			},
		}));
	},
}));
