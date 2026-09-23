/**
 * Brain — Zustand store
 *
 * The shared brain from the desktop app: where it is (Settings), and what one
 * Kanban task taught it (the task panel's card).
 *
 * Two halves with two lifetimes. The settings are one slot — the answer is
 * about a folder on this machine, not about a card. The task learning is keyed
 * by task id and cancels its own in-flight request, for the reason
 * `spec-traceability-store` does: the modal can be reopened on another card
 * while the previous request is still running, and a late answer must not
 * paint the card the user is no longer looking at.
 */

import { create } from "zustand";
import {
	type BrainSettings,
	type BrainSettingsUpdate,
	type BrainSyncResult,
	type BrainTaskLearning,
	fetchBrainSettings,
	fetchBrainTask,
	saveBrainSettings,
	setBrainInstructionStatus,
	syncBrain,
} from "../lib/agent-tools-api";

export interface BrainTaskEntry {
	learning: BrainTaskLearning | null;
	loading: boolean;
	error: string | null;
}

const EMPTY_TASK: BrainTaskEntry = { learning: null, loading: false, error: null };

export interface LoadBrainTaskArgs {
	taskId: string;
	projectDir?: string;
	specId?: string;
}

interface BrainState {
	settings: BrainSettings | null;
	settingsLoading: boolean;
	/** True when the backend refused because it is in server mode. */
	unavailable: boolean;
	/** The last save or sync failure, verbatim from the backend. */
	error: string | null;
	/** git's own message for that failure, when the backend had one. */
	errorDetail: string | null;
	saving: boolean;
	syncing: boolean;
	lastSync: BrainSyncResult | null;
	byTask: Record<string, BrainTaskEntry>;

	loadSettings: (force?: boolean) => Promise<void>;
	saveSettings: (update: BrainSettingsUpdate) => Promise<boolean>;
	sync: () => Promise<boolean>;
	loadTask: (args: LoadBrainTaskArgs) => Promise<void>;
	clearTask: (taskId: string) => void;
	setInstructionStatus: (
		args: LoadBrainTaskArgs,
		path: string,
		status: "active" | "retired",
	) => Promise<boolean>;
}

const isServerMode = (error?: string) =>
	error?.includes("desktop feature") ?? false;

const inFlight = new Map<string, AbortController>();

export const useBrainStore = create<BrainState>((set, get) => ({
	settings: null,
	settingsLoading: false,
	unavailable: false,
	error: null,
	errorDetail: null,
	saving: false,
	syncing: false,
	lastSync: null,
	byTask: {},

	loadSettings: async (force = false) => {
		const current = get();
		if (!force && (current.settings !== null || current.unavailable)) return;
		set({ settingsLoading: true });
		const res = await fetchBrainSettings();
		if (!res.ok) {
			set({
				settingsLoading: false,
				unavailable: isServerMode(res.error),
				error: isServerMode(res.error) ? null : res.error,
			});
			return;
		}
		set({ settings: res.data.settings, settingsLoading: false, error: null });
	},

	saveSettings: async (update) => {
		set({ saving: true, error: null, errorDetail: null });
		const res = await saveBrainSettings(update);
		if (!res.ok) {
			// The backend sends the settings back with the refusal: show where
			// the brain still is, not a stale copy.
			await get().loadSettings(true);
			set({ saving: false, error: res.error, errorDetail: res.detail ?? null });
			return false;
		}
		set({ saving: false, settings: res.data.settings, error: null });
		return true;
	},

	sync: async () => {
		set({ syncing: true, error: null, errorDetail: null });
		const res = await syncBrain();
		if (!res.ok) {
			set({ syncing: false, error: res.error, errorDetail: res.detail ?? null });
			return false;
		}
		set({ syncing: false, lastSync: res.data });
		await get().loadSettings(true);
		return true;
	},

	clearTask: (taskId) => {
		inFlight.get(taskId)?.abort();
		inFlight.delete(taskId);
		set((state) => {
			if (!(taskId in state.byTask)) return state;
			const next = { ...state.byTask };
			delete next[taskId];
			return { byTask: next };
		});
	},

	loadTask: async ({ taskId, projectDir, specId }) => {
		if (!projectDir || !specId) return;

		inFlight.get(taskId)?.abort();
		const controller = new AbortController();
		inFlight.set(taskId, controller);

		set((state) => ({
			byTask: {
				...state.byTask,
				[taskId]: {
					...(state.byTask[taskId] ?? EMPTY_TASK),
					loading: true,
					error: null,
				},
			},
		}));

		const res = await fetchBrainTask(projectDir, specId, controller.signal);

		// A request the store has already replaced does not get to answer.
		if (inFlight.get(taskId) !== controller) return;
		inFlight.delete(taskId);
		if (!res.ok && res.error === "aborted") return;

		set((state) => ({
			byTask: {
				...state.byTask,
				[taskId]: {
					...(state.byTask[taskId] ?? EMPTY_TASK),
					loading: false,
					learning: res.ok ? res.data.learning : null,
					error: res.ok || isServerMode(res.error) ? null : res.error,
				},
			},
		}));
	},

	setInstructionStatus: async (args, path, status) => {
		const res = await setBrainInstructionStatus(path, status);
		if (!res.ok) {
			set({ error: res.error });
			return false;
		}
		await get().loadTask(args);
		return true;
	},
}));
