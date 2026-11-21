/**
 * The Waves view: plan, Gantt-like layout, and "Execute in optimal order"
 * starting wave 1, then wave 2 (planned again) once wave 1 is merged.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStatus } from "../../../../shared/types";
import type { ExecutionWavePlan } from "../../../../shared/types/conflict-waves";
import { setupExecutionWavesListeners, useExecutionWavesStore } from "../../../stores/execution-waves-store";
import { useProjectStore } from "../../../stores/project-store";
import { useTaskStore } from "../../../stores/task-store";
import { WavesView } from "../WavesView";

const PROJECT = "p1";

function task(id: string, status: TaskStatus = "backlog"): Task {
	return { id, specId: id, projectId: PROJECT, title: `Spec ${id}`, description: "", status, subtasks: [], logs: [] } as unknown as Task;
}

function plan(waves: string[][], extra: Partial<ExecutionWavePlan> = {}): ExecutionWavePlan {
	const ids = waves.flat();
	return {
		projectId: PROJECT,
		maxParallel: 2,
		tolerance: 0,
		unplannedPolicy: "isolate",
		waves: waves.map((taskIds, i) => ({ index: i + 1, taskIds, residualRisk: 0 })),
		order: ids,
		tasks: ids.map((id) => ({ taskId: id, title: `Spec ${id}`, status: "backlog", fileCount: 2, planned: true })),
		pairs: [{ a: "a", b: "c", score: 3, level: "medium", sharedFiles: ["package.json"], unknown: false, blocking: true }],
		cycles: [],
		excluded: [],
		drift: [],
		runningConflicts: [],
		totalRisk: 3,
		residualRisk: 0,
		mergeChecks: { checked: 0, conflicts: 0, unchecked: 0, failed: 0 },
		fragileZones: { enabled: false, commits: null },
		computedAt: "2026-11-14T08:00:00.000Z",
		...extra,
	};
}

let api: Record<string, ReturnType<typeof vi.fn>>;
let unsubscribe: () => void;

beforeEach(() => {
	useExecutionWavesStore.setState(useExecutionWavesStore.getInitialState());
	useProjectStore.setState({
		selectedProjectId: PROJECT,
		projects: [{ id: PROJECT, settings: { maxParallelTasks: 2 } }] as never,
	});
	useTaskStore.setState({ tasks: [task("a"), task("b"), task("c")] });
	api = {
		planExecutionWaves: vi
			.fn()
			.mockResolvedValueOnce({ success: true, data: plan([["a", "b"], ["c"]]) })
			.mockResolvedValue({ success: true, data: plan([["c"]]) }),
		updateTaskStatus: vi.fn(async (taskId: string, status: TaskStatus) => {
			queueMicrotask(() => useTaskStore.getState().updateTaskStatus(taskId, status));
			return { success: true };
		}),
	};
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = api;
	unsubscribe = setupExecutionWavesListeners();
});

afterEach(() => {
	unsubscribe();
	cleanup();
});

describe("WavesView", () => {
	it("asks for a project first", () => {
		useProjectStore.setState({ selectedProjectId: null });
		render(<WavesView />);
		expect(screen.getByText("Select a project to plan its waves.")).toBeInTheDocument();
	});

	it("computes the waves by project id and lays them out", async () => {
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "Compute the waves" }));
		await screen.findByTestId("wave-1");
		expect(api.planExecutionWaves).toHaveBeenCalledWith({
			projectId: PROJECT,
			options: { tolerance: 0, unplannedPolicy: "isolate", fragileZones: true },
		});
		expect(screen.getByRole("table", { name: "Plan" })).toBeInTheDocument();
		expect(screen.getAllByText("Wave 2").length).toBeGreaterThan(0);
		expect(screen.getByText("Riskiest pairs")).toBeInTheDocument();
	});

	it("shows cycles, drift and running conflicts", async () => {
		api.planExecutionWaves.mockReset().mockResolvedValue({
			success: true,
			data: plan([["a"]], {
				excluded: [
					{ taskId: "b", reason: "cycle" },
					{ taskId: "c", reason: "cycle" },
				],
				cycles: [["b", "c"]],
				tasks: ["a", "b", "c"].map((id) => ({ taskId: id, title: `Spec ${id}`, status: "backlog", fileCount: 1, planned: true })),
				drift: [{ taskId: "a", extraCount: 5, extraFiles: [] }],
				runningConflicts: [{ taskId: "a", runningTaskId: "r", score: 2 }],
			}),
		});
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "Compute the waves" }));
		expect(await screen.findByText(/Dependency cycle/)).toHaveTextContent("Spec b, Spec c");
		expect(screen.getByText(/touched 5 files outside its plan/)).toBeInTheDocument();
		expect(screen.getByText(/already running/)).toBeInTheDocument();
	});

	it("executes wave 1, then plans the rest again and starts wave 2 once wave 1 is merged", async () => {
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "Compute the waves" }));
		await screen.findByTestId("wave-1");
		fireEvent.click(screen.getByRole("button", { name: "Execute in optimal order" }));

		await waitFor(() => expect(api.updateTaskStatus).toHaveBeenCalledTimes(2));
		expect(api.updateTaskStatus).toHaveBeenNthCalledWith(1, "a", "in_progress", undefined);
		expect(api.updateTaskStatus).toHaveBeenNthCalledWith(2, "b", "in_progress", undefined);
		expect(await screen.findByText("Running wave 1 of 2.")).toBeInTheDocument();

		await act(async () => {
			useTaskStore.getState().updateTaskStatus("a", "done");
			useTaskStore.getState().updateTaskStatus("b", "done");
		});
		await waitFor(() => expect(api.updateTaskStatus).toHaveBeenCalledWith("c", "in_progress", undefined));
		expect(api.planExecutionWaves).toHaveBeenLastCalledWith({
			projectId: PROJECT,
			taskIds: ["c"],
			options: { tolerance: 0, unplannedPolicy: "isolate", fragileZones: true },
		});

		await act(async () => {
			useTaskStore.getState().updateTaskStatus("c", "done");
		});
		expect(await screen.findByText("Every wave has run.")).toBeInTheDocument();
	});

	it("stops starting waves when stopped", async () => {
		useTaskStore.setState({ tasks: [task("a"), task("b"), task("c"), task("x", "in_progress"), task("y", "in_progress")] });
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "Compute the waves" }));
		await screen.findByTestId("wave-1");
		fireEvent.click(screen.getByRole("button", { name: "Execute in optimal order" }));
		// No room: the two running tasks fill the project's max parallelism.
		fireEvent.click(await screen.findByRole("button", { name: "Stop the run" }));
		await act(async () => {
			useTaskStore.getState().updateTaskStatus("x", "done");
		});
		expect(api.updateTaskStatus).not.toHaveBeenCalled();
		expect(screen.getByText(/Run stopped at wave 1 of 2/)).toBeInTheDocument();
	});

	it("sends the chosen options and shows an empty project", async () => {
		api.planExecutionWaves.mockReset().mockResolvedValue({
			success: true,
			data: plan([], { order: [], tasks: [], pairs: [], totalRisk: 0 }),
		});
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "1 shared file" }));
		fireEvent.click(screen.getByRole("button", { name: "Assume independent" }));
		fireEvent.click(screen.getByRole("button", { name: "Run them alone" }));
		fireEvent.click(screen.getByRole("button", { name: "Assume independent" }));
		fireEvent.click(screen.getByRole("button", { name: "once the wave is in review" }));
		fireEvent.click(screen.getByRole("button", { name: "once the wave is merged" }));
		fireEvent.click(screen.getByRole("button", { name: "once the wave is in review" }));
		fireEvent.click(screen.getByRole("button", { name: "Compute the waves" }));
		expect(await screen.findByText("No spec is waiting in the backlog or queue.")).toBeInTheDocument();
		expect(api.planExecutionWaves).toHaveBeenCalledWith({
			projectId: PROJECT,
			options: { tolerance: 1, unplannedPolicy: "independent", fragileZones: true },
		});
		expect(useExecutionWavesStore.getState().options.advanceWhen).toBe("review");
		expect(screen.getByRole("button", { name: "Execute in optimal order" })).toBeDisabled();
	});

	it("shows a planning error", async () => {
		api.planExecutionWaves.mockReset().mockResolvedValue({ success: false, error: "Project not found" });
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "Compute the waves" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Project not found");
	});

	it("shows a plan made only of a cycle, unplanned specs, residual risk and soft pairs", async () => {
		api.planExecutionWaves.mockReset().mockResolvedValue({
			success: true,
			data: plan([["a", "b"]], {
				waves: [{ index: 1, taskIds: ["a", "b"], residualRisk: 1 }],
				tasks: [
					{ taskId: "a", title: "Spec a", status: "backlog", fileCount: 2, planned: true },
					{ taskId: "b", title: "Spec b", status: "backlog", fileCount: 0, planned: false },
					{ taskId: "d", title: "Spec d", status: "backlog", fileCount: 1, planned: true },
				],
				excluded: [{ taskId: "d", reason: "blocked_by_cycle" }],
				pairs: [
					{ a: "a", b: "b", score: 0, level: "none", sharedFiles: [], unknown: true, blocking: false },
					{ a: "a", b: "d", score: 1, level: "low", sharedFiles: ["x"], unknown: false, blocking: false },
				],
			}),
		});
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "Compute the waves" }));
		expect(await screen.findByText(/Waiting on a spec of a cycle: Spec d/)).toBeInTheDocument();
		expect(screen.getByText("1 specs have no plan yet: their footprint is unknown.")).toBeInTheDocument();
		expect(screen.getByText("no plan")).toBeInTheDocument();
		expect(screen.getByText("Residual risk 1")).toBeInTheDocument();
		expect(screen.getByText("unknown footprint")).toBeInTheDocument();
		expect(screen.getAllByText("may share a wave")).toHaveLength(2);
	});

	it("shows a plan whose specs are all in a cycle", async () => {
		api.planExecutionWaves.mockReset().mockResolvedValue({
			success: true,
			data: plan([], { order: [], pairs: [], excluded: [{ taskId: "a", reason: "cycle" }] }),
		});
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "Compute the waves" }));
		expect(await screen.findByText(/Dependency cycle/)).toBeInTheDocument();
		expect(screen.queryByText("No spec is waiting in the backlog or queue.")).toBeNull();
	});

	it("marks waves done, running and pending, names a blocked task and a refused start", async () => {
		// The re-plan fails: the first plan stays on screen, wave 1 is shown done.
		api.planExecutionWaves
			.mockReset()
			.mockResolvedValueOnce({ success: true, data: plan([["a"], ["b"], ["c"]]) })
			.mockResolvedValue({ success: false, error: "busy" });
		useTaskStore.setState({
			tasks: [task("a"), task("b"), { ...task("c"), metadata: { blockedBy: ["z"] } } as Task, task("z", "human_review")],
		});
		api.updateTaskStatus.mockImplementation(async (taskId: string, status: TaskStatus) => {
			if (taskId === "b") return { success: false, error: "Git check failed" };
			queueMicrotask(() => useTaskStore.getState().updateTaskStatus(taskId, status));
			return { success: true };
		});
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "Compute the waves" }));
		await screen.findByTestId("wave-1");
		fireEvent.click(screen.getByRole("button", { name: "Execute in optimal order" }));
		await waitFor(() => expect(api.updateTaskStatus).toHaveBeenCalledWith("a", "in_progress", undefined));
		await act(async () => {
			useTaskStore.getState().updateTaskStatus("a", "done");
		});
		expect(await screen.findByText("Could not start Spec b: Git check failed")).toBeInTheDocument();
		expect(await screen.findByText("Running wave 3 of 3.")).toBeInTheDocument();
		expect(screen.getByText("Waiting on an unfinished dependency: Spec c")).toBeInTheDocument();
		const states = [...document.querySelectorAll("td[data-state]")].map((cell) => cell.getAttribute("data-state"));
		expect(states).toEqual(["finished", "finished", "current"]);
		expect(screen.getAllByTitle("done")).toHaveLength(2);
		expect(screen.getByTitle("running")).toBeInTheDocument();

		// Another project selected: this run is not shown there.
		act(() => useProjectStore.setState({ selectedProjectId: "p2" }));
		expect(screen.queryByText("Running wave 3 of 3.")).toBeNull();
	});

	it("shows pending bars before a run", async () => {
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "Compute the waves" }));
		await screen.findByTestId("wave-1");
		const states = [...document.querySelectorAll("td[data-state]")].map((cell) => cell.getAttribute("data-state"));
		expect(states).toEqual(["pending", "pending", "pending"]);
	});
});

describe("WavesView, preventive merge check", () => {
	it("says which pair a test merge split and on which files, and what was not checked", async () => {
		api.planExecutionWaves.mockReset().mockResolvedValue({
			success: true,
			data: plan([["a", "c"], ["b"]], {
				tolerance: 2,
				pairs: [
					{ a: "a", b: "b", score: 1, level: "low", sharedFiles: ["src/cart.go"], unknown: false, blocking: true, mergeCheck: "conflict", conflictFiles: ["src/cart.go", "go.sum"] },
					{ a: "a", b: "c", score: 1, level: "low", sharedFiles: ["README.md"], unknown: false, blocking: false, mergeCheck: "clean", conflictFiles: [] },
					{ a: "b", b: "c", score: 1, level: "low", sharedFiles: ["x"], unknown: false, blocking: true, mergeCheck: "conflict" },
				],
				mergeChecks: { checked: 3, conflicts: 2, unchecked: 4, failed: 1 },
			}),
		});
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "Compute the waves" }));
		const notice = await screen.findByText(/Spec a and Spec b are under the tolerance/);
		expect(notice).toHaveTextContent("conflicts on src/cart.go, go.sum");
		expect(screen.getByText(/Spec b and Spec c are under the tolerance/)).toBeInTheDocument();
		expect(screen.getByText(/3 checked, 2 split/)).toBeInTheDocument();
		expect(screen.getByText(/4 pairs sharing a wave were not test-merged/)).toBeInTheDocument();
		expect(screen.getByText(/Git could not test-merge 1 pairs/)).toBeInTheDocument();
		expect(screen.getAllByText("test merge conflicts")).toHaveLength(2);
		expect(screen.getByText("test merge clean")).toBeInTheDocument();
	});

	it("says nothing of test merges when none was run", async () => {
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "Compute the waves" }));
		await screen.findByTestId("wave-1");
		expect(screen.queryByText(/Test merges/)).toBeNull();
	});
});

describe("WavesView, a run saved before a restart", () => {
	const SAVED = {
		projectId: PROJECT,
		waves: [["a"], ["b", "c"]],
		current: 1,
		advanceWhen: "merged" as const,
		maxParallel: 2,
		started: ["a"],
		savedAt: "2026-11-16T07:00:00.000Z",
	};

	beforeEach(() => {
		api.loadExecutionWaveRun = vi.fn(async () => ({ success: true, data: { run: SAVED, ignored: false } }));
		api.saveExecutionWaveRun = vi.fn(async () => ({ success: true }));
		api.clearExecutionWaveRun = vi.fn(async () => ({ success: true }));
		useTaskStore.setState({ tasks: [task("a", "done"), task("b"), task("c")] });
	});

	it("offers to resume it, then shows the run's waves until a plan is computed", async () => {
		await useExecutionWavesStore.getState().loadSavedRun(PROJECT);
		render(<WavesView />);
		expect(screen.getByTestId("saved-wave-run")).toHaveTextContent("interrupted at wave 2 of 2");
		fireEvent.click(screen.getByRole("button", { name: "Resume the run" }));
		expect(await screen.findByText("Running wave 2 of 2.")).toBeInTheDocument();
		expect(screen.queryByTestId("saved-wave-run")).toBeNull();
		expect(screen.getByText("Waves of the resumed run")).toBeInTheDocument();
		expect(screen.getByText("Spec b, Spec c")).toBeInTheDocument();
		const states = [...document.querySelectorAll("li[data-state]")].map((li) => li.getAttribute("data-state"));
		expect(states).toEqual(["finished", "current"]);
		await waitFor(() => expect(api.updateTaskStatus).toHaveBeenCalledWith("b", "in_progress", undefined));
	});

	it("lists a pending wave of the resumed run as such", async () => {
		api.loadExecutionWaveRun = vi.fn(async () => ({
			success: true,
			data: { run: { ...SAVED, waves: [["a"], ["b"], ["c"]], current: 1 }, ignored: false },
		}));
		await useExecutionWavesStore.getState().loadSavedRun(PROJECT);
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "Resume the run" }));
		await screen.findByText("Running wave 2 of 3.");
		const states = [...document.querySelectorAll("li[data-state]")].map((li) => li.getAttribute("data-state"));
		expect(states).toEqual(["finished", "current", "pending"]);
	});

	it("abandons it on request", async () => {
		await useExecutionWavesStore.getState().loadSavedRun(PROJECT);
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "Abandon it" }));
		await waitFor(() => expect(api.clearExecutionWaveRun).toHaveBeenCalledWith(PROJECT));
		expect(screen.queryByTestId("saved-wave-run")).toBeNull();
		expect(api.updateTaskStatus).not.toHaveBeenCalled();
	});

	it("says so when a saved run was ignored", async () => {
		api.loadExecutionWaveRun = vi.fn(async () => ({ success: true, data: { run: null, ignored: true } }));
		await useExecutionWavesStore.getState().loadSavedRun(PROJECT);
		render(<WavesView />);
		expect(screen.getByText(/could not be read or no longer matches its tasks/)).toBeInTheDocument();
	});

	it("shows a run saved for another project nowhere", async () => {
		useExecutionWavesStore.setState({ savedRun: { ...SAVED, projectId: "p2" } });
		render(<WavesView />);
		expect(screen.queryByTestId("saved-wave-run")).toBeNull();
	});
});

describe("WavesView, fragile zones", () => {
	it("shows the fragile links of a pair and how far back the history was read", async () => {
		api.planExecutionWaves.mockReset().mockResolvedValue({
			success: true,
			data: plan([["a"], ["b"]], {
				pairs: [
					{ a: "a", b: "b", score: 1, level: "low", sharedFiles: [], unknown: false, blocking: true, fragileLinks: ["db/schema.sql ↔ db/0001.cs"] },
				],
				fragileZones: { enabled: true, commits: 300 },
			}),
		});
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "Compute the waves" }));
		expect(await screen.findByText("1 fragile links")).toBeInTheDocument();
		expect(screen.getByText(/changed together in the last 300 commits/)).toBeInTheDocument();
	});

	it("says when the history could not be read", async () => {
		api.planExecutionWaves.mockReset().mockResolvedValue({
			success: true,
			data: plan([["a"]], { fragileZones: { enabled: true, commits: null } }),
		});
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "Compute the waves" }));
		expect(await screen.findByText(/could not read the project's history/)).toBeInTheDocument();
	});

	it("turns them off and on for the next plan", async () => {
		render(<WavesView />);
		fireEvent.click(screen.getByRole("button", { name: "Off" }));
		fireEvent.click(screen.getByRole("button", { name: "Compute the waves" }));
		await screen.findByTestId("wave-1");
		expect(api.planExecutionWaves).toHaveBeenLastCalledWith({
			projectId: PROJECT,
			options: { tolerance: 0, unplannedPolicy: "isolate", fragileZones: false },
		});
		fireEvent.click(screen.getByRole("button", { name: "From the history" }));
		expect(useExecutionWavesStore.getState().options.fragileZones).toBe(true);
	});
});
