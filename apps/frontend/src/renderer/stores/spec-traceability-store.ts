/**
 * Spec traceability — Zustand store
 *
 * What the spec left open (`[NEEDS CLARIFICATION]`) and what the plan will not
 * build (a requirement no subtask claims), for one task.
 *
 * Keyed by task id and cancelling its own in-flight request, for the same
 * reason `workflow-profile-store` is: the modal can be reopened on a different
 * card while the previous request is still running, and a single slot would
 * let a late answer paint the card the user is no longer looking at.
 */

import { create } from "zustand";
import {
	type TraceabilityPayload,
	fetchSpecTraceability,
} from "../lib/agent-tools-api";

export interface SpecTraceabilityEntry {
	traceability: TraceabilityPayload | null;
	loading: boolean;
	error: string | null;
}

const EMPTY: SpecTraceabilityEntry = {
	traceability: null,
	loading: false,
	error: null,
};

export interface LoadSpecTraceabilityArgs {
	taskId: string;
	/** Either an absolute spec directory… */
	specDir?: string;
	/** …or the pair that names it. The server owns the layout. */
	projectDir?: string;
	specId?: string;
}

interface SpecTraceabilityState {
	byTask: Record<string, SpecTraceabilityEntry>;
	load: (args: LoadSpecTraceabilityArgs) => Promise<void>;
	clear: (taskId: string) => void;
}

const inFlight = new Map<string, AbortController>();

export const useSpecTraceabilityStore = create<SpecTraceabilityState>((set) => ({
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

	load: async ({ taskId, projectDir, specId, specDir }) => {
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
				},
			},
		}));

		const res = await fetchSpecTraceability(
			{ projectDir, specId, specDir },
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
					traceability: res.ok ? res.data : null,
					error: res.ok ? null : res.error,
				},
			},
		}));
	},
}));
