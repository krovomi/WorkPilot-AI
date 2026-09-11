/**
 * Hermes — Zustand store
 *
 * Whether the hermes-agent learning loop can run on this machine, whether the
 * persona this repository offers is installed, and what it has already filed in
 * the review queue.
 *
 * A single slot rather than a map keyed by task, unlike `spec-traceability-store`:
 * every answer here is about the machine and the checkout, not about a card. Two
 * task panels open on the same project ask the same question and deserve the same
 * answer, so the second one costs nothing.
 */

import { create } from "zustand";
import {
	type HermesCycle,
	type HermesStatus,
	fetchHermesStatus,
	installHermesSoul,
	runHermesCycle,
} from "../lib/agent-tools-api";

export interface HermesState {
	status: HermesStatus | null;
	/** The last cycle this session ran, so the panel can report what it filed. */
	lastCycle: HermesCycle | null;
	loading: boolean;
	running: boolean;
	/** True when the backend refused because it is in server mode. */
	unavailable: boolean;
	error: string | null;

	load: (force?: boolean) => Promise<void>;
	runCycle: (surface: string) => Promise<void>;
	installSoul: (overwrite: boolean) => Promise<void>;
	reset: () => void;
}

let inFlight: AbortController | null = null;

export const useHermesStore = create<HermesState>((set, get) => ({
	status: null,
	lastCycle: null,
	loading: false,
	running: false,
	unavailable: false,
	error: null,

	reset: () => {
		inFlight?.abort();
		inFlight = null;
		set({
			status: null,
			lastCycle: null,
			loading: false,
			running: false,
			unavailable: false,
			error: null,
		});
	},

	load: async (force = false) => {
		// The answer changes when someone installs hermes or trusts the
		// checkout — both rare, both outside this app. Re-reading on every
		// panel open would be a filesystem stat storm for a value that is
		// stable for days, so a loaded status is kept unless asked again.
		if (!force && (get().status !== null || get().unavailable)) return;

		inFlight?.abort();
		const controller = new AbortController();
		inFlight = controller;
		set({ loading: true, error: null });

		const res = await fetchHermesStatus(controller.signal);
		if (controller.signal.aborted) return;
		inFlight = null;

		if (!res.ok) {
			set({
				loading: false,
				// A refusal in server mode is not an error to show in red; it
				// is "this feature is not in use here", which the card renders
				// by rendering nothing.
				unavailable: res.error.includes("desktop feature"),
				error: res.error.includes("desktop feature") ? null : res.error,
			});
			return;
		}
		set({ status: res.data.status, loading: false, unavailable: false });
	},

	runCycle: async (surface) => {
		if (get().running) return;
		set({ running: true, error: null });
		const res = await runHermesCycle(surface);
		if (!res.ok) {
			set({ running: false, error: res.error });
			return;
		}
		const cycle = res.data.cycle;
		set((state) => ({
			running: false,
			lastCycle: cycle,
			status: state.status
				? {
						...state.status,
						readiness: cycle.readiness,
						pending: cycle.pending,
					}
				: state.status,
		}));
	},

	installSoul: async (overwrite) => {
		set({ running: true, error: null });
		const res = await installHermesSoul(overwrite);
		if (!res.ok) {
			set({ running: false, error: res.error });
			return;
		}
		set((state) => ({
			running: false,
			status: state.status
				? { ...state.status, soul: res.data.soul }
				: state.status,
		}));
		// The persona is one of the doctor's five conditions, so its verdict
		// changed too.
		await get().load(true);
	},
}));
