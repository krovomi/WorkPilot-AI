/**
 * Docintel — Zustand store
 *
 * What the agents will read from a task's attachments (diagrams, screenshots,
 * documents) and which of the project's ADRs bind the build, for one task.
 *
 * Keyed by task id and cancelling its own in-flight request, for the same
 * reason `spec-traceability-store` is: the modal can be reopened on another
 * card while the previous request runs, and a late answer must not paint the
 * card the user is no longer looking at.
 */

import { create } from "zustand";
import { type DocintelPayload, fetchDocintel } from "../lib/agent-tools-api";

export interface DocintelEntry {
	data: DocintelPayload | null;
	loading: boolean;
	error: string | null;
}

const EMPTY: DocintelEntry = { data: null, loading: false, error: null };

export interface LoadDocintelArgs {
	taskId: string;
	specDir?: string;
	projectDir?: string;
	specId?: string;
}

interface DocintelState {
	byTask: Record<string, DocintelEntry>;
	load: (args: LoadDocintelArgs) => Promise<void>;
	clear: (taskId: string) => void;
}

const inFlight = new Map<string, AbortController>();

export const useDocintelStore = create<DocintelState>((set) => ({
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
				[taskId]: { ...(state.byTask[taskId] ?? EMPTY), loading: true, error: null },
			},
		}));

		const res = await fetchDocintel(
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
					data: res.ok ? res.data : null,
					error: res.ok ? null : res.error,
				},
			},
		}));
	},
}));
