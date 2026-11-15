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
	UnplannedPolicy,
	WaveAdvanceWhen,
} from "../../shared/types/conflict-waves";
import { stepWaveExecution, type WaveExecution } from "../lib/wave-execution";
import { persistTaskStatus, useTaskStore } from "./task-store";

export interface WaveOptions {
	tolerance: number;
	unplannedPolicy: UnplannedPolicy;
	advanceWhen: WaveAdvanceWhen;
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
	setOptions: (patch: Partial<WaveOptions>) => void;
	computePlan: (projectId: string) => Promise<void>;
	execute: () => Promise<void>;
	stop: () => void;
	tick: () => Promise<void>;
}

const DEFAULT_OPTIONS: WaveOptions = {
	tolerance: 0,
	unplannedPolicy: "isolate",
	advanceWhen: "merged",
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

	setOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch } })),

	computePlan: async (projectId) => {
		const { tolerance, unplannedPolicy } = get().options;
		set({ isPlanning: true, error: null });
		try {
			const result = await globalThis.electronAPI.planExecutionWaves({
				projectId,
				options: { tolerance, unplannedPolicy },
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
			},
			blocked: [],
			startFailures: {},
		});
		await get().tick();
	},

	stop: () => {
		const { execution } = get();
		if (execution?.status === "running") {
			set({ execution: { ...execution, status: "stopped" }, blocked: [] });
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
	const { tolerance, unplannedPolicy } = get().options;
	try {
		const result = await globalThis.electronAPI.planExecutionWaves({
			projectId: execution.projectId,
			taskIds: remaining,
			options: { tolerance, unplannedPolicy },
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

/** Runs the execution on every change of the task list. */
export function setupExecutionWavesListeners(): () => void {
	return useTaskStore.subscribe((state, previous) => {
		if (state.tasks === previous.tasks) return;
		if (useExecutionWavesStore.getState().execution?.status !== "running") return;
		void useExecutionWavesStore.getState().tick();
	});
}
