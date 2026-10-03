/**
 * Verification loop — Zustand store
 *
 * The record of the `verify` phase per task (`GET /api/verify/`), and a re-run
 * on request (`POST /api/verify/run`). Keyed by task id, and a request the
 * store has already replaced does not get to answer: a re-run launches the
 * app and can outlast the modal it was started from — the rule
 * `docintel-visual-store` follows, for the same reason.
 */

import { create } from "zustand";
import {
	fetchVerify,
	runVerify,
	type SpecTraceabilityQuery,
	type VerifyPayload,
} from "../lib/agent-tools-api";

export type VerifyBusy = "loading" | "running" | null;

export interface VerifyEntry {
	data: VerifyPayload | null;
	busy: VerifyBusy;
	error: string | null;
}

const EMPTY: VerifyEntry = { data: null, busy: null, error: null };

interface VerifyState {
	byTask: Record<string, VerifyEntry>;
	load: (taskId: string, query: SpecTraceabilityQuery) => Promise<void>;
	run: (taskId: string, query: SpecTraceabilityQuery, effort?: string) => Promise<void>;
	clear: (taskId: string) => void;
}

const inFlight = new Map<string, AbortController>();

function addressable(query: SpecTraceabilityQuery): boolean {
	return Boolean(query.specDir || (query.projectDir && query.specId));
}

export const useVerifyStore = create<VerifyState>((set, get) => {
	const patch = (taskId: string, changes: Partial<VerifyEntry>) =>
		set((state) => ({
			byTask: {
				...state.byTask,
				[taskId]: { ...(state.byTask[taskId] ?? EMPTY), ...changes },
			},
		}));

	const begin = (taskId: string, busy: VerifyBusy): AbortController => {
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

	const settle = (taskId: string, res: Awaited<ReturnType<typeof fetchVerify>>) => {
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
			const res = await fetchVerify(query, controller.signal);
			if (!current(taskId, controller)) return;
			if (!res.ok && res.error === "aborted") return;
			settle(taskId, res);
		},

		run: async (taskId, query, effort) => {
			if (!addressable(query)) return;
			const controller = begin(taskId, "running");
			const res = await runVerify(query, { effort }, controller.signal);
			if (!current(taskId, controller)) return;
			if (!res.ok && res.error === "aborted") return;
			settle(taskId, res);
		},
	};
});

/** Whether a record is worth a tab: something ran and said something. */
export function hasVerifyRecord(entry: VerifyEntry | undefined): boolean {
	const status = entry?.data?.record?.status;
	return Boolean(status && status !== "disabled");
}
