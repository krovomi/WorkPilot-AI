/**
 * Hermes — Zustand store
 *
 * Whether the hermes-agent learning loop can run on this machine, whether the
 * persona this repository offers is installed, what it has filed in the review
 * queue — and the two answers a person gives back: keep or turn down.
 *
 * A single slot rather than a map keyed by task, unlike `spec-traceability-store`:
 * every answer here is about the machine and the checkout, not about a card. Two
 * task panels open on the same project ask the same question and deserve the same
 * answer, so the second one costs nothing.
 *
 * The cycle is automatic. It already runs at the end of every build (the
 * `observe` phase); `autoCycle` adds the moment a person opens a task panel, at
 * most once every `AUTO_CYCLE_INTERVAL_MS`, so what hermes learned since the
 * last build is in front of them without a button to remember. The manual
 * refresh stays for the impatient.
 */

import { create } from "zustand";
import {
	type HermesCycle,
	type HermesDecision,
	type HermesReviewOutcome,
	type HermesStatus,
	fetchHermesStatus,
	installHermesSoul,
	reviewHermesCandidates,
	runHermesCycle,
} from "../lib/agent-tools-api";

/** How long a cycle's answer stays fresh before opening a panel runs another. */
export const AUTO_CYCLE_INTERVAL_MS = 15 * 60 * 1000;

export interface HermesTaskContext {
	readonly projectDir?: string;
	readonly specId?: string;
}

export interface HermesState {
	status: HermesStatus | null;
	/** The last cycle this session ran, so the panel can report what it filed. */
	lastCycle: HermesCycle | null;
	/** When that cycle ran (epoch ms), for the automatic throttle. */
	lastRunAt: number | null;
	/** The last decision taken from the panel, for its confirmation line. */
	lastReview: (HermesReviewOutcome & { decision: HermesDecision }) | null;
	/** Queue files a decision is being written for. */
	deciding: readonly string[];
	loading: boolean;
	running: boolean;
	/** True when the backend refused because it is in server mode. */
	unavailable: boolean;
	error: string | null;

	load: (force?: boolean) => Promise<void>;
	runCycle: (surface: string) => Promise<void>;
	/** Run a cycle if none ran recently. Never throws, never stacks. */
	autoCycle: (surface: string, now?: number) => Promise<void>;
	review: (
		files: readonly string[],
		decision: HermesDecision,
		task?: HermesTaskContext,
	) => Promise<void>;
	installSoul: (overwrite: boolean) => Promise<void>;
	reset: () => void;
}

let inFlight: AbortController | null = null;

export const useHermesStore = create<HermesState>((set, get) => ({
	status: null,
	lastCycle: null,
	lastRunAt: null,
	lastReview: null,
	deciding: [],
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
			lastRunAt: null,
			lastReview: null,
			deciding: [],
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
			set({ running: false, error: res.error, lastRunAt: Date.now() });
			return;
		}
		const { cycle, status: fresh } = res.data;
		set((state) => ({
			running: false,
			lastCycle: cycle,
			lastRunAt: Date.now(),
			// The backend re-reads the whole status after the cycle; an older
			// backend only sends the cycle, and the status is patched from it.
			status:
				fresh ??
				(state.status
					? {
							...state.status,
							readiness: cycle.readiness,
							pending: cycle.pending,
							stale: cycle.stale,
							adopted: [
								...state.status.adopted,
								...(cycle.ingest?.adopted.filter(
									(name) => !state.status?.adopted.includes(name),
								) ?? []),
							],
						}
					: state.status),
		}));
	},

	autoCycle: async (surface, now = Date.now()) => {
		const { running, unavailable, lastRunAt, status } = get();
		if (running || unavailable) return;
		if (status && !status.readiness.installed) return;
		if (lastRunAt !== null && now - lastRunAt < AUTO_CYCLE_INTERVAL_MS) return;
		await get().runCycle(surface);
	},

	review: async (files, decision, task) => {
		if (files.length === 0) return;
		const already = get().deciding;
		const todo = files.filter((f) => !already.includes(f));
		if (todo.length === 0) return;
		set({ deciding: [...already, ...todo], error: null });
		const res = await reviewHermesCandidates(todo, decision, task);
		set((state) => ({
			deciding: state.deciding.filter((f) => !todo.includes(f)),
		}));
		if (!res.ok) {
			set({ error: res.error });
			return;
		}
		set({
			status: res.data.status,
			lastReview: { ...res.data.review, decision },
		});
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
