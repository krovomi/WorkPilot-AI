/**
 * A run that survives a restart (#358, lot 2): saved at every step, forgotten
 * once finished or stopped, offered to resume or abandon when its project is
 * selected, never resumed without the person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStatus } from "../../../shared/types";
import type { ExecutionWavePlan, SavedWaveRun } from "../../../shared/types/conflict-waves";
import { setupExecutionWavesListeners, useExecutionWavesStore } from "../execution-waves-store";
import { useProjectStore } from "../project-store";
import { useTaskStore } from "../task-store";

const PROJECT = "p1";

function task(id: string, status: TaskStatus = "backlog"): Task {
	return { id, specId: id, projectId: PROJECT, title: id, description: "", status, subtasks: [], logs: [] } as unknown as Task;
}

function plan(waves: string[][]): ExecutionWavePlan {
	const ids = waves.flat();
	return {
		projectId: PROJECT,
		maxParallel: 3,
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
		computedAt: "2026-11-16T08:00:00.000Z",
	};
}

const SAVED: SavedWaveRun = {
	projectId: PROJECT,
	waves: [["a"], ["b", "c"]],
	current: 1,
	advanceWhen: "review",
	maxParallel: 2,
	started: ["a"],
	savedAt: "2026-11-16T07:00:00.000Z",
};

type Api = Record<string, ReturnType<typeof vi.fn>>;
let api: Api;
let unsubscribe: () => void;
const store = () => useExecutionWavesStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

function install(overrides: Partial<Api> = {}) {
	api = {
		planExecutionWaves: vi.fn(async () => ({ success: true, data: plan([["c"]]) })),
		updateTaskStatus: vi.fn(async (id: string, status: TaskStatus) => {
			queueMicrotask(() => useTaskStore.getState().updateTaskStatus(id, status));
			return { success: true };
		}),
		loadExecutionWaveRun: vi.fn(async () => ({ success: true, data: { run: null, ignored: false } })),
		saveExecutionWaveRun: vi.fn(async () => ({ success: true })),
		clearExecutionWaveRun: vi.fn(async () => ({ success: true })),
		...overrides,
	};
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = api;
}

beforeEach(() => {
	useExecutionWavesStore.setState(useExecutionWavesStore.getInitialState());
	useProjectStore.setState({ selectedProjectId: null });
	useTaskStore.setState({ tasks: [task("a", "done"), task("b"), task("c")] });
	install();
	unsubscribe = setupExecutionWavesListeners();
});

afterEach(() => unsubscribe());

describe("saving the run", () => {
	it("saves every step without its status, and forgets the run once every wave ran", async () => {
		useTaskStore.setState({ tasks: [task("a"), task("b")] });
		useExecutionWavesStore.setState({ plan: plan([["a", "b"]]) });
		await store().execute();
		await flush();
		const saved = api.saveExecutionWaveRun.mock.calls.map(([state]) => state);
		expect(saved[0]).toEqual({
			projectId: PROJECT,
			waves: [["a", "b"]],
			current: 0,
			advanceWhen: "merged",
			maxParallel: 3,
			started: [],
		});
		expect(saved.at(-1)).toMatchObject({ started: ["a", "b"] });
		expect(saved.every((state) => !("status" in state))).toBe(true);

		useTaskStore.getState().updateTaskStatus("a", "done");
		useTaskStore.getState().updateTaskStatus("b", "done");
		await flush();
		await flush();
		expect(store().execution?.status).toBe("done");
		expect(api.clearExecutionWaveRun).toHaveBeenCalledWith(PROJECT);
	});

	it("forgets a stopped run, and saves nothing more after", async () => {
		useExecutionWavesStore.setState({ plan: plan([["b"], ["c"]]) });
		await store().execute();
		await flush();
		const saves = api.saveExecutionWaveRun.mock.calls.length;
		store().stop();
		await flush();
		expect(api.clearExecutionWaveRun).toHaveBeenCalledWith(PROJECT);
		useExecutionWavesStore.setState({ blocked: ["x"] });
		await flush();
		expect(api.saveExecutionWaveRun).toHaveBeenCalledTimes(saves);
	});

	it("neither saves nor clears a run that was never running, and ignores other project changes", async () => {
		useExecutionWavesStore.setState({
			execution: { projectId: PROJECT, waves: [["b"]], current: 0, advanceWhen: "merged", maxParallel: 1, started: [], status: "stopped" },
		});
		useProjectStore.setState({ projects: [] });
		await flush();
		expect(api.saveExecutionWaveRun).not.toHaveBeenCalled();
		expect(api.clearExecutionWaveRun).not.toHaveBeenCalled();
		expect(api.loadExecutionWaveRun).not.toHaveBeenCalled();
	});

	it("keeps running when a save fails, and saves again at the next step", async () => {
		install({ saveExecutionWaveRun: vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue({ success: true }) });
		useExecutionWavesStore.setState({ plan: plan([["b", "c"]]) });
		await store().execute();
		await flush();
		expect(store().execution?.status).toBe("running");
		expect(api.saveExecutionWaveRun.mock.calls.length).toBeGreaterThan(1);
	});
});

describe("a run saved before a restart", () => {
	it("is offered when its project is selected, and resumed only on request", async () => {
		api.loadExecutionWaveRun.mockResolvedValue({ success: true, data: { run: SAVED, ignored: false } });
		useProjectStore.setState({ selectedProjectId: PROJECT });
		await flush();
		expect(api.loadExecutionWaveRun).toHaveBeenCalledWith(PROJECT);
		expect(store().savedRun).toEqual(SAVED);
		expect(store().execution).toBeNull();
		expect(api.updateTaskStatus).not.toHaveBeenCalled();

		await store().resumeSavedRun();
		await flush();
		expect(store().savedRun).toBeNull();
		expect(store().execution).toMatchObject({ status: "running", current: 1, advanceWhen: "review" });
		expect(store().options.advanceWhen).toBe("review");
		// Wave 2 goes on where it was: both of its tasks start, `a` is not started again.
		expect(api.updateTaskStatus.mock.calls.map(([id]) => id)).toEqual(["b", "c"]);
	});

	it("is read at start-up for the project already selected", async () => {
		unsubscribe();
		api.loadExecutionWaveRun.mockResolvedValue({ success: true, data: { run: SAVED, ignored: false } });
		useProjectStore.setState({ selectedProjectId: PROJECT });
		unsubscribe = setupExecutionWavesListeners();
		await flush();
		expect(store().savedRun).toEqual(SAVED);
	});

	it("is forgotten when abandoned", async () => {
		useExecutionWavesStore.setState({ savedRun: SAVED });
		await store().abandonSavedRun();
		expect(store().savedRun).toBeNull();
		expect(api.clearExecutionWaveRun).toHaveBeenCalledWith(PROJECT);
		expect(api.updateTaskStatus).not.toHaveBeenCalled();
	});

	it("says when a saved run was ignored, for that project only", async () => {
		api.loadExecutionWaveRun.mockResolvedValue({ success: true, data: { run: null, ignored: true } });
		useProjectStore.setState({ selectedProjectId: PROJECT });
		await flush();
		expect(store().savedRunIgnoredFor).toBe(PROJECT);
		api.loadExecutionWaveRun.mockResolvedValue({ success: true, data: { run: null, ignored: false } });
		useProjectStore.setState({ selectedProjectId: "p2" });
		await flush();
		expect(store().savedRunIgnoredFor).toBeNull();
	});

	it("is replaced by a new run", async () => {
		useExecutionWavesStore.setState({ savedRun: SAVED, plan: plan([["b"]]) });
		await store().execute();
		expect(store().savedRun).toBeNull();
	});

	it("is not offered over a run going on, nor when the answer comes too late", async () => {
		api.loadExecutionWaveRun.mockResolvedValue({ success: true, data: { run: SAVED, ignored: false } });
		useExecutionWavesStore.setState({ plan: plan([["b"], ["c"]]) });
		await store().execute();
		useProjectStore.setState({ selectedProjectId: PROJECT });
		await flush();
		expect(api.loadExecutionWaveRun).not.toHaveBeenCalled();
		expect(store().savedRun).toBeNull();

		// A run started while the saved one was being read.
		store().stop();
		let answer: (value: unknown) => void = () => undefined;
		api.loadExecutionWaveRun.mockReturnValue(new Promise((r) => (answer = r)));
		useProjectStore.setState({ selectedProjectId: "p2" });
		useProjectStore.setState({ selectedProjectId: PROJECT });
		await store().execute();
		answer({ success: true, data: { run: SAVED, ignored: false } });
		await flush();
		expect(store().savedRun).toBeNull();
	});

	it("drops an answer for a project no longer selected, a refusal and a bridge failure", async () => {
		let answer: (value: unknown) => void = () => undefined;
		api.loadExecutionWaveRun.mockReturnValueOnce(new Promise((r) => (answer = r)));
		useProjectStore.setState({ selectedProjectId: PROJECT });
		useProjectStore.setState({ selectedProjectId: null });
		answer({ success: true, data: { run: SAVED, ignored: false } });
		await flush();
		expect(store().savedRun).toBeNull();

		api.loadExecutionWaveRun.mockResolvedValueOnce({ success: false, error: "Project not found" });
		await store().loadSavedRun(PROJECT);
		api.loadExecutionWaveRun.mockRejectedValueOnce(new Error("bridge down"));
		await store().loadSavedRun(PROJECT);
		expect(store().savedRun).toBeNull();
	});

	it("does nothing to resume or abandon when there is no saved run, or over a run going on", async () => {
		await store().resumeSavedRun();
		await store().abandonSavedRun();
		expect(store().execution).toBeNull();
		expect(api.clearExecutionWaveRun).not.toHaveBeenCalled();

		useExecutionWavesStore.setState({ plan: plan([["b"]]) });
		await store().execute();
		const running = store().execution;
		useExecutionWavesStore.setState({ savedRun: SAVED });
		await store().resumeSavedRun();
		expect(store().execution).toBe(running);
	});
});
