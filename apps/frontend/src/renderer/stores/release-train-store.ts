import { create } from "zustand";
import type { ReleaseTrainEvent } from "../../preload/api/modules/release-coordinator-api";
import type {
	TrainAction,
	TrainMonth,
	TrainNotes,
	TrainRun,
	TrainState,
} from "../../shared/types/release-train";

/** The release train page (#362): the train file, its approval, the run on screen. */
interface ReleaseTrainStore {
	projectPath: string;
	loading: boolean;
	busy: boolean;
	state: TrainState | null;
	run: TrainRun | null;
	live: ReleaseTrainEvent | null;
	notes: TrainNotes | null;
	months: TrainMonth[];
	error: string | null;

	load: (projectPath: string) => Promise<void>;
	approve: () => Promise<void>;
	start: (environment: string, options?: { services?: string[]; express?: boolean }) => Promise<void>;
	act: (action: TrainAction, target?: string) => Promise<void>;
	openRun: (runId: string) => Promise<void>;
	loadNotes: (ai: boolean) => Promise<void>;
	onEvent: (event: ReleaseTrainEvent) => void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const useReleaseTrainStore = create<ReleaseTrainStore>((set, get) => {
	/** A call that moves a run: the page shows its outcome, then the train file again. */
	const moving = async (call: () => Promise<TrainRun>) => {
		set({ busy: true, error: null, live: null });
		try {
			const run = await call();
			set({ run });
		} catch (err) {
			set({ error: message(err) });
		} finally {
			set({ busy: false, live: null });
			await get().load(get().projectPath);
		}
	};

	return {
		projectPath: "",
		loading: false,
		busy: false,
		state: null,
		run: null,
		live: null,
		notes: null,
		months: [],
		error: null,

		load: async (projectPath) => {
			if (!projectPath) return;
			const changed = projectPath !== get().projectPath;
			set({ projectPath, loading: true, ...(changed ? { run: null, notes: null, error: null } : {}) });
			try {
				const [state, metrics] = await Promise.all([
					globalThis.electronAPI.releaseTrainState(projectPath),
					globalThis.electronAPI.releaseTrainMetrics(projectPath).catch(() => ({ months: [] })),
				]);
				const latest = state.view?.runs[0];
				const run = get().run ?? (latest && !["done", "aborted"].includes(latest.status) ? latest : null);
				set({ state, months: metrics.months, run });
			} catch (err) {
				set({ error: message(err) });
			} finally {
				set({ loading: false });
			}
		},

		approve: async () => {
			const { projectPath, state } = get();
			if (!state?.view) return;
			set({ busy: true, error: null });
			try {
				const ok = await globalThis.electronAPI.approveReleaseTrain(projectPath, state.view.sha256);
				if (!ok) set({ error: "changed" });
			} catch (err) {
				set({ error: message(err) });
			} finally {
				set({ busy: false });
				await get().load(projectPath);
			}
		},

		start: (environment, options = {}) =>
			moving(() =>
				globalThis.electronAPI.startReleaseTrain({ projectPath: get().projectPath, environment, ...options }),
			),

		act: (action, target) => {
			const run = get().run;
			if (!run) return Promise.resolve();
			return moving(() =>
				globalThis.electronAPI.advanceReleaseTrain({
					projectPath: get().projectPath,
					runId: run.id,
					action,
					target,
				}),
			);
		},

		openRun: async (runId) => {
			try {
				set({ run: await globalThis.electronAPI.releaseTrainRun(get().projectPath, runId) });
			} catch (err) {
				set({ error: message(err) });
			}
		},

		loadNotes: async (ai) => {
			set({ busy: true, error: null });
			try {
				set({ notes: await globalThis.electronAPI.releaseTrainNotes(get().projectPath, ai) });
			} catch (err) {
				set({ error: message(err) });
			} finally {
				set({ busy: false });
			}
		},

		onEvent: (event) => {
			// Only one run moves at a time from this page: its own process sends these.
			if (get().busy) set({ live: event });
		},
	};
});
