/**
 * The "Execute in optimal order" run: guards, failures of the plan and of
 * the start path, re-planning, and a stop that lands mid-step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStatus } from "../../../shared/types";
import type { ExecutionWavePlan } from "../../../shared/types/conflict-waves";
import { setupExecutionWavesListeners, useExecutionWavesStore } from "../execution-waves-store";
import { useTaskStore } from "../task-store";

const PROJECT = "p1";

function task(id: string, status: TaskStatus = "backlog"): Task {
	return { id, specId: id, projectId: PROJECT, title: id, description: "", status, subtasks: [], logs: [] } as unknown as Task;
}

function plan(waves: string[][], maxParallel = 3): ExecutionWavePlan {
	const ids = waves.flat();
	return {
		projectId: PROJECT,
		maxParallel,
		tolerance: 0,
		unplannedPolicy: "isolate",
		waves: waves.map((taskIds, i) => ({ index: i + 1, taskIds, residualRisk: 0 })),
		order: ids,
		tasks: ids.map((id) => ({ taskId: id, title: id, status: "backlog", fileCount: 1, planned: true })),
		pairs: [],
		cycles: [],
		excluded: [],
		drift: [],
		runningConflicts: [],
		totalRisk: 0,
		residualRisk: 0,
		mergeChecks: { checked: 0, conflicts: 0, unchecked: 0, failed: 0 },
		fragileZones: { enabled: false, commits: null },
		codeLinks: { enabled: false, files: 0, capped: false },
		computedAt: "2026-11-14T08:00:00.000Z",
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

let api: { planExecutionWaves: ReturnType<typeof vi.fn>; updateTaskStatus: ReturnType<typeof vi.fn> };
let unsubscribe: () => void;

const store = () => useExecutionWavesStore.getState();
const setStatus = (id: string, status: TaskStatus) => useTaskStore.getState().updateTaskStatus(id, status);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	useExecutionWavesStore.setState(useExecutionWavesStore.getInitialState());
	useTaskStore.setState({ tasks: [task("a"), task("b"), task("c")] });
	api = {
		planExecutionWaves: vi.fn(),
		updateTaskStatus: vi.fn(async (id: string, status: TaskStatus) => {
			queueMicrotask(() => setStatus(id, status));
			return { success: true };
		}),
	};
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = api;
	unsubscribe = setupExecutionWavesListeners();
});

afterEach(() => unsubscribe());

describe("computePlan", () => {
	it.each([
		["with its reason", { success: false, error: "Project not found" }, "Project not found"],
		["without a reason", { success: false }, ""],
	])("reports a refusal %s", async (_name, answer, error) => {
		api.planExecutionWaves.mockResolvedValue(answer);
		await store().computePlan(PROJECT);
		expect(store()).toMatchObject({ plan: null, isPlanning: false, error });
	});

	it("reports a bridge failure", async () => {
		api.planExecutionWaves.mockRejectedValue(new Error("bridge down"));
		await store().computePlan(PROJECT);
		expect(store().error).toBe("Error: bridge down");
	});
});

describe("execute", () => {
	it("does nothing without a plan, or with a plan of no wave", async () => {
		await store().execute();
		useExecutionWavesStore.setState({ plan: plan([]) });
		await store().execute();
		expect(store().execution).toBeNull();
	});

	it("does not start a second run over a running one", async () => {
		useExecutionWavesStore.setState({ plan: plan([["a"], ["b"]]) });
		await store().execute();
		const first = store().execution;
		await store().execute();
		expect(store().execution).toBe(first);
		expect(api.updateTaskStatus).toHaveBeenCalledTimes(1);
	});

	it("does nothing on a tick or a stop with no run", async () => {
		await store().tick();
		store().stop();
		expect(store().execution).toBeNull();
	});

	it("records the start path's refusals, with or without a reason", async () => {
		api.updateTaskStatus
			.mockResolvedValueOnce({ success: false, error: "Git check failed" })
			.mockResolvedValueOnce({ success: false });
		useExecutionWavesStore.setState({ plan: plan([["a", "b"]]) });
		await store().execute();
		expect(store().startFailures).toEqual({ a: "Git check failed", b: "" });
		// Refused tasks stay in the backlog: the wave does not wait on them.
		await store().tick();
		expect(store().execution?.status).toBe("done");
	});

	it("stops starting tasks when stopped between two starts", async () => {
		api.updateTaskStatus.mockImplementationOnce(async () => {
			store().stop();
			return { success: true };
		});
		useExecutionWavesStore.setState({ plan: plan([["a", "b"]]) });
		await store().execute();
		expect(api.updateTaskStatus).toHaveBeenCalledTimes(1);
		expect(store().execution?.status).toBe("stopped");
	});

	it("runs one step at a time when ticks overlap", async () => {
		const gate = deferred<{ success: boolean }>();
		api.updateTaskStatus.mockImplementationOnce(() => gate.promise);
		useExecutionWavesStore.setState({ plan: plan([["a", "b"]], 1) });
		const running = store().execute();
		await flush();
		await store().tick(); // overlaps: queued, not run beside the first
		gate.resolve({ success: true });
		await running;
		expect(api.updateTaskStatus).toHaveBeenCalledTimes(1);
	});
});

describe("re-planning at a wave boundary", () => {
	async function finishFirstWave(waves: string[][]) {
		useExecutionWavesStore.setState({ plan: plan(waves) });
		await store().execute();
		setStatus("a", "done");
		await flush();
		await flush();
	}

	it("keeps the waves planned before when the new plan is refused or fails", async () => {
		api.planExecutionWaves.mockResolvedValueOnce({ success: false, error: "x" }).mockRejectedValueOnce(new Error("y"));
		useTaskStore.setState({ tasks: [task("a"), task("b"), task("c")] });
		await finishFirstWave([["a"], ["b"], ["c"]]);
		expect(store().execution).toMatchObject({ current: 1, waves: [["a"], ["b"], ["c"]] });
		setStatus("b", "done");
		await flush();
		await flush();
		expect(store().execution).toMatchObject({ current: 2, waves: [["a"], ["b"], ["c"]] });
	});

	it("skips the new plan when nothing is left to start", async () => {
		useTaskStore.setState({ tasks: [task("a"), task("b", "in_progress")] });
		await finishFirstWave([["a"], ["b", "gone"]]);
		expect(api.planExecutionWaves).not.toHaveBeenCalled();
		expect(store().execution?.current).toBe(1);
	});

	it("takes the new plan's waves and parallelism", async () => {
		api.planExecutionWaves.mockResolvedValueOnce({ success: true, data: plan([["c"], ["b"]], 1) });
		await finishFirstWave([["a"], ["b", "c"]]);
		expect(api.planExecutionWaves).toHaveBeenCalledWith(expect.objectContaining({ taskIds: ["b", "c"] }));
		expect(store().execution).toMatchObject({ waves: [["a"], ["c"], ["b"]], maxParallel: 1 });
		expect(store().plan?.waves).toHaveLength(2);
	});

	it("stays stopped when stopped while the rest is being planned", async () => {
		const answer = deferred<unknown>();
		api.planExecutionWaves.mockReturnValueOnce(answer.promise);
		await finishFirstWave([["a"], ["b"]]);
		store().stop();
		answer.resolve({ success: true, data: plan([["b"]]) });
		await flush();
		expect(store().execution).toMatchObject({ status: "stopped", current: 0 });
		expect(api.updateTaskStatus).toHaveBeenCalledTimes(1);
	});
});

describe("setupExecutionWavesListeners", () => {
	it("ignores task changes with no run, and store changes that are not tasks", async () => {
		const tick = vi.spyOn(store(), "tick");
		setStatus("a", "done");
		useExecutionWavesStore.setState({ plan: plan([["b"]]) });
		await store().execute();
		tick.mockClear();
		useTaskStore.setState({ isLoading: true } as never);
		expect(tick).not.toHaveBeenCalled();
	});
});
