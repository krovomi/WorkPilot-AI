/**
 * rtk — Zustand store
 *
 * Whether the output-condensing proxy is working on this machine, and what it
 * has saved on this project.
 *
 * One slot rather than a map keyed by task, like `hermes-store`: the answer is
 * about a binary on the machine and a project on disk, not about a card. Two
 * task panels open on the same project ask the same question, and the second
 * one costs nothing.
 *
 * The savings half moves, so it is re-read when asked; the readiness half
 * changes when somebody installs rtk, which is rare and outside this app. Both
 * come from the same endpoint because splitting them would double a call that
 * already costs one exec against a local database.
 */

import { create } from "zustand";
import { type RtkStatus, fetchRtkStatus } from "../lib/agent-tools-api";

export interface RtkState {
	status: RtkStatus | null;
	loading: boolean;
	/** True when the backend refused because it is in server mode. */
	unavailable: boolean;
	error: string | null;
	/** The project the loaded status describes, so a switch re-reads. */
	projectDir: string | null;

	load: (projectDir?: string, force?: boolean) => Promise<void>;
	reset: () => void;
}

let inFlight: AbortController | null = null;

export const useRtkStore = create<RtkState>((set, get) => ({
	status: null,
	loading: false,
	unavailable: false,
	error: null,
	projectDir: null,

	reset: () => {
		inFlight?.abort();
		inFlight = null;
		set({
			status: null,
			loading: false,
			unavailable: false,
			error: null,
			projectDir: null,
		});
	},

	load: async (projectDir?: string, force = false) => {
		const current = get();
		const sameProject = current.projectDir === (projectDir ?? null);
		if (!force && sameProject && (current.status !== null || current.unavailable)) {
			return;
		}

		inFlight?.abort();
		const controller = new AbortController();
		inFlight = controller;
		set({ loading: true, error: null });

		const res = await fetchRtkStatus(projectDir, controller.signal);
		if (controller.signal.aborted) return;
		inFlight = null;

		if (!res.ok) {
			// "not here" is an answer, not an error: the server-mode refusal is
			// the backend saying this is a desktop feature, and a red message
			// about it would be noise on every panel open.
			const serverMode = res.error?.includes("desktop feature") ?? false;
			set({
				loading: false,
				unavailable: serverMode,
				error: serverMode || res.error === "aborted" ? null : res.error,
				projectDir: projectDir ?? null,
			});
			return;
		}

		set({
			status: res.data.status,
			loading: false,
			unavailable: false,
			error: null,
			projectDir: projectDir ?? null,
		});
	},
}));
