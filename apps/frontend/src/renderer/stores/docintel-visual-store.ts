/**
 * Docintel visual QA — Zustand store
 *
 * What the captures of a task's running application showed (OCR), per task,
 * and the two actions a person takes on it: keep a frame as a capture (from
 * the emulator's preview or the device frame), and read the captures now.
 *
 * Keyed by task id; a request the store has already replaced does not get to
 * answer — the rule `docintel-drafts-store` follows, for the same reason: the
 * OCR of a dozen captures can outlast the modal it was started from.
 */

import { create } from "zustand";
import {
	type CaptureInput,
	fetchVisualQa,
	runVisualQa,
	saveCapture,
	type SpecTraceabilityQuery,
	type VisualQaPayload,
} from "../lib/agent-tools-api";

export type VisualBusy = "loading" | "running" | "capturing" | null;

export interface VisualEntry {
	data: VisualQaPayload | null;
	busy: VisualBusy;
	error: string | null;
}

const EMPTY: VisualEntry = { data: null, busy: null, error: null };

interface VisualState {
	byTask: Record<string, VisualEntry>;
	load: (taskId: string, query: SpecTraceabilityQuery) => Promise<void>;
	run: (taskId: string, query: SpecTraceabilityQuery) => Promise<void>;
	/** The path the capture was saved under, or null (the error is on the entry). */
	capture: (
		taskId: string,
		query: SpecTraceabilityQuery,
		input: CaptureInput,
	) => Promise<string | null>;
	clear: (taskId: string) => void;
}

const inFlight = new Map<string, AbortController>();

function addressable(query: SpecTraceabilityQuery): boolean {
	return Boolean(query.specDir || (query.projectDir && query.specId));
}

export const useDocintelVisualStore = create<VisualState>((set, get) => {
	const patch = (taskId: string, changes: Partial<VisualEntry>) =>
		set((state) => ({
			byTask: {
				...state.byTask,
				[taskId]: { ...(state.byTask[taskId] ?? EMPTY), ...changes },
			},
		}));

	const begin = (taskId: string, busy: VisualBusy): AbortController => {
		inFlight.get(taskId)?.abort();
		const controller = new AbortController();
		inFlight.set(taskId, controller);
		patch(taskId, { busy, error: null });
		return controller;
	};

	const current = (taskId: string, controller: AbortController): boolean => {
		if (inFlight.get(taskId) !== controller) return false;
		inFlight.delete(taskId);
		return true;
	};

	const settle = (
		taskId: string,
		res: Awaited<ReturnType<typeof fetchVisualQa>>,
	) => {
		patch(taskId, {
			busy: null,
			data: res.ok ? res.data : (get().byTask[taskId]?.data ?? null),
			error: res.ok ? null : res.error,
		});
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
			const res = await fetchVisualQa(query, controller.signal);
			if (!current(taskId, controller)) return;
			if (!res.ok && res.error === "aborted") return;
			settle(taskId, res);
		},

		run: async (taskId, query) => {
			if (!addressable(query)) return;
			const controller = begin(taskId, "running");
			const res = await runVisualQa(query, controller.signal);
			if (!current(taskId, controller)) return;
			if (!res.ok && res.error === "aborted") return;
			settle(taskId, res);
		},

		capture: async (taskId, query, input) => {
			if (!addressable(query)) return null;
			const controller = begin(taskId, "capturing");
			const res = await saveCapture(query, input, controller.signal);
			if (!current(taskId, controller)) return null;
			if (!res.ok && res.error === "aborted") return null;
			settle(taskId, res);
			return res.ok ? (res.data.saved ?? null) : null;
		},
	};
});
