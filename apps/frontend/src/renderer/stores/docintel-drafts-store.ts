/**
 * Docintel drafts — Zustand store
 *
 * What a task's attachments propose (requirements, acceptance criteria, rule
 * tables and their parametrised tests), for one task, and the three actions a
 * person takes on it: read the attachments now, decide, and turn a whiteboard
 * photo into a diagram.
 *
 * Keyed by task id, and a request the store has already replaced does not get
 * to answer — the same rule as `docintel-store`: the modal can be reopened on
 * another card while a slow extraction (a scanned PDF's OCR) is still running.
 */

import { create } from "zustand";
import {
	convertWhiteboard,
	type DocintelDraftsPayload,
	type DraftDecision,
	type DraftDecisionResult,
	decideDocintelDrafts,
	extractDocintelDrafts,
	fetchDocintelDrafts,
	type SpecTraceabilityQuery,
	type WhiteboardResult,
} from "../lib/agent-tools-api";

export type DraftsBusy = "loading" | "extracting" | "deciding" | "converting" | null;

export interface DraftsEntry {
	data: DocintelDraftsPayload | null;
	busy: DraftsBusy;
	error: string | null;
	/** The last whiteboard conversion, by photo path. */
	whiteboards: Record<string, WhiteboardResult>;
}

const EMPTY: DraftsEntry = {
	data: null,
	busy: null,
	error: null,
	whiteboards: {},
};

interface DraftsState {
	byTask: Record<string, DraftsEntry>;
	load: (taskId: string, query: SpecTraceabilityQuery) => Promise<void>;
	extract: (taskId: string, query: SpecTraceabilityQuery) => Promise<void>;
	decide: (
		taskId: string,
		query: SpecTraceabilityQuery,
		decision: DraftDecision,
	) => Promise<DraftDecisionResult | null>;
	convert: (
		taskId: string,
		query: SpecTraceabilityQuery,
		path: string,
	) => Promise<WhiteboardResult | null>;
	clear: (taskId: string) => void;
}

const inFlight = new Map<string, AbortController>();

function addressable(query: SpecTraceabilityQuery): boolean {
	return Boolean(query.specDir || (query.projectDir && query.specId));
}

export const useDocintelDraftsStore = create<DraftsState>((set, get) => {
	const patch = (taskId: string, changes: Partial<DraftsEntry>) =>
		set((state) => ({
			byTask: {
				...state.byTask,
				[taskId]: { ...(state.byTask[taskId] ?? EMPTY), ...changes },
			},
		}));

	/** Start a request for this task, cancelling the one it replaces. */
	const begin = (taskId: string, busy: DraftsBusy): AbortController => {
		inFlight.get(taskId)?.abort();
		const controller = new AbortController();
		inFlight.set(taskId, controller);
		patch(taskId, { busy, error: null });
		return controller;
	};

	/** Whether this request is still the one the task is waiting for. */
	const current = (taskId: string, controller: AbortController): boolean => {
		if (inFlight.get(taskId) !== controller) return false;
		inFlight.delete(taskId);
		return true;
	};

	return {
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

		load: async (taskId, query) => {
			if (!addressable(query)) return;
			const controller = begin(taskId, "loading");
			const res = await fetchDocintelDrafts(query, controller.signal);
			if (!current(taskId, controller)) return;
			if (!res.ok && res.error === "aborted") return;
			patch(taskId, {
				busy: null,
				data: res.ok ? res.data : get().byTask[taskId]?.data ?? null,
				error: res.ok ? null : res.error,
			});
		},

		extract: async (taskId, query) => {
			if (!addressable(query)) return;
			const controller = begin(taskId, "extracting");
			const res = await extractDocintelDrafts(query, controller.signal);
			if (!current(taskId, controller)) return;
			if (!res.ok && res.error === "aborted") return;
			patch(taskId, {
				busy: null,
				data: res.ok ? res.data : get().byTask[taskId]?.data ?? null,
				error: res.ok ? null : res.error,
			});
		},

		decide: async (taskId, query, decision) => {
			if (!addressable(query)) return null;
			const controller = begin(taskId, "deciding");
			const res = await decideDocintelDrafts(query, decision, controller.signal);
			if (!current(taskId, controller)) return null;
			if (!res.ok) {
				if (res.error !== "aborted") patch(taskId, { busy: null, error: res.error });
				return null;
			}
			const { decision: result, ...data } = res.data;
			patch(taskId, { busy: null, data, error: null });
			return result;
		},

		convert: async (taskId, query, path) => {
			if (!addressable(query)) return null;
			const controller = begin(taskId, "converting");
			const res = await convertWhiteboard(query, path, controller.signal);
			if (!current(taskId, controller)) return null;
			if (!res.ok) {
				if (res.error !== "aborted") patch(taskId, { busy: null, error: res.error });
				return null;
			}
			patch(taskId, {
				busy: null,
				error: null,
				whiteboards: {
					...(get().byTask[taskId]?.whiteboards ?? {}),
					[path]: res.data.result,
				},
			});
			return res.data.result;
		},
	};
});
