/**
 * Execution waves across specs (#358): the plan the main process computed,
 * and the "Execute in optimal order" run that starts wave after wave.
 *
 * The run watches the task store for the window's lifetime
 * (`setupExecutionWavesListeners`, registered by `global-listeners.ts`), so it
 * keeps going when the person leaves the page. When a wave settles, the rest
 * is planned again from the worktrees as they are now (dynamic re-planning).
 * It lives in memory: closing the app ends the run, never the tasks.
 */

import { create } from "zustand";
import type {
	ExecutionWavePlan,
	SavedWaveRun,
	UnplannedPolicy,
	WaveAdvanceWhen,
	WaveRunAvoided,
	WaveRunHistory,
	WaveRunState,
} from "../../shared/types/conflict-waves";
import { stepWaveExecution, type WaveExecution } from "../lib/wave-execution";
import { useProjectStore } from "./project-store";
import { persistTaskStatus, useTaskStore } from "./task-store";

export interface WaveOptions {
	tolerance: number;
	unplannedPolicy: UnplannedPolicy;
	advanceWhen: WaveAdvanceWhen;
	/** Count files the history changes together (fragile zones). */
	fragileZones: boolean;
	/** Count imports of what the other spec edits and uses of what it removes. */
	codeLinks: boolean;
}

interface ExecutionWavesState {
	plan: ExecutionWavePlan | null;
	isPlanning: boolean;
	error: string | null;
	options: WaveOptions;
	execution: WaveExecution | null;
	/** Tasks of the current wave waiting on an unfinished dependency. */
	blocked: string[];
	/** Tasks the start path refused, with its reason. */
	startFailures: Record<string, string>;
	/** A run saved in the project before a restart, waiting for the person. */
	savedRun: SavedWaveRun | null;
	/** Project whose saved run could not be read or was incoherent. */
	savedRunIgnoredFor: string | null;
	/** The selected project's run history (sprint metrics). */
	history: (WaveRunHistory & { projectId: string }) | null;
	setOptions: (patch: Partial<WaveOptions>) => void;
	computePlan: (projectId: string) => Promise<void>;
	execute: () => Promise<void>;
	stop: () => void;
	tick: () => Promise<void>;
	loadSavedRun: (projectId: string) => Promise<void>;
	resumeSavedRun: () => Promise<void>;
	abandonSavedRun: () => Promise<void>;
	loadHistory: (projectId: string) => Promise<void>;
}

const DEFAULT_OPTIONS: WaveOptions = {
	tolerance: 0,
	unplannedPolicy: "isolate",
	advanceWhen: "merged",
	fragileZones: true,
	codeLinks: true,
};

const NOT_STARTED = new Set(["backlog", "queue"]);

let ticking = false;
let tickAgain = false;

export const useExecutionWavesStore = create<ExecutionWavesState>((set, get) => ({
	plan: null,
	isPlanning: false,
	error: null,
	options: DEFAULT_OPTIONS,
	execution: null,
	blocked: [],
	startFailures: {},
	savedRun: null,
	savedRunIgnoredFor: null,
	history: null,

	setOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch } })),

	computePlan: async (projectId) => {
		const { tolerance, unplannedPolicy, fragileZones, codeLinks } = get().options;
		set({ isPlanning: true, error: null });
		try {
			const result = await globalThis.electronAPI.planExecutionWaves({
				projectId,
				options: { tolerance, unplannedPolicy, fragileZones, codeLinks },
			});
			if (result.data) {
				set({ plan: result.data, isPlanning: false });
			} else {
				set({ isPlanning: false, error: result.error ?? "" });
			}
		} catch (error) {
			set({ isPlanning: false, error: String(error) });
		}
	},

	execute: async () => {
		const { plan, options, execution } = get();
		if (!plan || plan.waves.length === 0 || execution?.status === "running") return;
		set({
			execution: {
				projectId: plan.projectId,
				waves: plan.waves.map((w) => [...w.taskIds]),
				current: 0,
				advanceWhen: options.advanceWhen,
				maxParallel: plan.maxParallel,
				status: "running",
				started: [],
				avoided: avoidedBy(plan),
			},
			blocked: [],
			startFailures: {},
			savedRun: null,
		});
		await get().tick();
	},

	stop: () => {
		const { execution } = get();
		if (execution?.status === "running") {
			set({ execution: { ...execution, status: "stopped" }, blocked: [] });
		}
	},

	loadSavedRun: async (projectId) => {
		if (get().execution?.status === "running") return;
		try {
			const result = await globalThis.electronAPI.loadExecutionWaveRun(projectId);
			const data = result.data;
			// A run started meanwhile, or another project selected: drop the answer.
			if (
				!data ||
				get().execution?.status === "running" ||
				useProjectStore.getState().selectedProjectId !== projectId
			) {
				return;
			}
			set({
				savedRun: data.run,
				savedRunIgnoredFor: data.ignored ? projectId : null,
			});
		} catch {
			// Nothing to offer: the run can always be planned again.
		}
	},

	resumeSavedRun: async () => {
		const { savedRun, execution } = get();
		if (!savedRun || execution?.status === "running") return;
		const { savedAt: _savedAt, ...state } = savedRun;
		set({
			execution: { ...state, status: "running" },
			savedRun: null,
			blocked: [],
			startFailures: {},
			options: { ...get().options, advanceWhen: state.advanceWhen },
		});
		await get().tick();
	},

	abandonSavedRun: async () => {
		const { savedRun } = get();
		if (!savedRun) return;
		set({ savedRun: null });
		await persist(() => globalThis.electronAPI.clearExecutionWaveRun(savedRun.projectId));
	},

	loadHistory: async (projectId) => {
		try {
			const result = await globalThis.electronAPI.loadExecutionWaveHistory(projectId);
			// Another project selected meanwhile: drop the answer.
			if (!result.data || useProjectStore.getState().selectedProjectId !== projectId) return;
			set({ history: { ...result.data, projectId } });
		} catch {
			// No history shown: the waves still plan and run.
		}
	},

	tick: async () => {
		if (ticking) {
			tickAgain = true;
			return;
		}
		ticking = true;
		try {
			do {
				tickAgain = false;
				await runStep(get, set);
			} while (tickAgain);
		} finally {
			ticking = false;
		}
	},
}));

/**
 * What a plan avoids, for the run history: the pairs of planned specs it
 * keeps in different waves (over the tolerance, or split by a test merge),
 * and the risk it takes out. Unknown footprints are not counted.
 */
export function avoidedBy(plan: ExecutionWavePlan): WaveRunAvoided {
	const planned = new Set(plan.order);
	const conflicts = plan.pairs.filter(
		(p) => p.blocking && !p.unknown && planned.has(p.a) && planned.has(p.b),
	).length;
	return { conflicts, risk: Math.max(0, plan.totalRisk - plan.residualRisk) };
}

type Get = () => ExecutionWavesState;
type Set = (partial: Partial<ExecutionWavesState>) => void;

async function runStep(get: Get, set: Set): Promise<void> {
	const execution = get().execution;
	if (execution?.status !== "running") return;
	const step = stepWaveExecution(execution, useTaskStore.getState().tasks);

	if (step.finished) {
		set({ execution: { ...execution, status: "done" }, blocked: [] });
		return;
	}
	if (step.waveSettled) {
		const advanced = await replanRemaining(get, execution);
		// Stopped while the plan was being recomputed: stay stopped.
		if (get().execution?.status !== "running") return;
		set({ execution: advanced, blocked: [] });
		tickAgain = true;
		return;
	}

	set({ blocked: step.blocked });
	if (step.promote.length === 0) return;
	set({ execution: { ...execution, started: [...execution.started, ...step.promote] } });
	const failures: Record<string, string> = {};
	for (const taskId of step.promote) {
		if (get().execution?.status !== "running") break;
		const result = await persistTaskStatus(taskId, "in_progress");
		if (!result.success) failures[taskId] = result.error ?? "";
	}
	set({ startFailures: { ...get().startFailures, ...failures } });
	// Look again: a refused start leaves its task in the backlog, which
	// settles it, and no task change may follow to wake the run.
	tickAgain = true;
}

/**
 * Next wave, planned again: the specs not started yet are scored from their
 * plans and from what the finished and running worktrees really changed.
 * When planning fails, the waves computed before are kept.
 */
async function replanRemaining(get: Get, execution: WaveExecution): Promise<WaveExecution> {
	const next = execution.current + 1;
	const done = execution.waves.slice(0, next);
	const tasks = new Map(useTaskStore.getState().tasks.map((t) => [t.id, t]));
	const remaining = execution.waves
		.slice(next)
		.flat()
		.filter((id) => {
			const task = tasks.get(id);
			return task !== undefined && NOT_STARTED.has(task.status);
		});
	if (remaining.length === 0) {
		return { ...execution, current: next };
	}
	const { tolerance, unplannedPolicy, fragileZones, codeLinks } = get().options;
	try {
		const result = await globalThis.electronAPI.planExecutionWaves({
			projectId: execution.projectId,
			taskIds: remaining,
			options: { tolerance, unplannedPolicy, fragileZones, codeLinks },
		});
		if (result.data) {
			const replanned = result.data.waves.map((w) => [...w.taskIds]);
			// Specs the new plan leaves out (a cycle) are not started.
			useExecutionWavesStore.setState({ plan: result.data });
			return {
				...execution,
				waves: [...done, ...replanned],
				current: next,
				maxParallel: result.data.maxParallel,
			};
		}
	} catch {
		// Keep the waves planned before.
	}
	return { ...execution, current: next };
}

/** Saves and clears run one after the other, in the order they were asked. */
let persistQueue: Promise<void> = Promise.resolve();

function persist(write: () => Promise<unknown>): Promise<void> {
	const next = persistQueue
		.then(async () => {
			await write();
		})
		.catch(() => {
			// The run goes on in memory; the next step saves it again.
		});
	persistQueue = next;
	return next;
}

function runState(execution: WaveExecution): WaveRunState {
	const { status: _status, ...state } = execution;
	return state;
}

/**
 * Runs the execution on every change of the task list, saves it in the
 * project at every step (forgets it once finished or stopped), and offers a
 * run saved before a restart when its project is selected.
 */
export function setupExecutionWavesListeners(): () => void {
	const offTasks = useTaskStore.subscribe((state, previous) => {
		if (state.tasks === previous.tasks) return;
		if (useExecutionWavesStore.getState().execution?.status !== "running") return;
		void useExecutionWavesStore.getState().tick();
	});
	const offRun = useExecutionWavesStore.subscribe((state, previous) => {
		const execution = state.execution;
		if (!execution || execution === previous.execution) return;
		if (execution.status === "running") {
			const saved = runState(execution);
			void persist(() => globalThis.electronAPI.saveExecutionWaveRun(saved));
		} else if (previous.execution?.status === "running") {
			// The main process records the run it saved, then forgets it.
			const { projectId, status } = execution;
			void persist(() => globalThis.electronAPI.clearExecutionWaveRun(projectId, status)).then(() =>
				useExecutionWavesStore.getState().loadHistory(projectId),
			);
		}
	});
	const load = (projectId: string | null) => {
		if (!projectId) return;
		void useExecutionWavesStore.getState().loadSavedRun(projectId);
		void useExecutionWavesStore.getState().loadHistory(projectId);
	};
	const offProject = useProjectStore.subscribe((state, previous) => {
		if (state.selectedProjectId !== previous.selectedProjectId) load(state.selectedProjectId);
	});
	load(useProjectStore.getState().selectedProjectId);
	return () => {
		offTasks();
		offRun();
		offProject();
	};
}
