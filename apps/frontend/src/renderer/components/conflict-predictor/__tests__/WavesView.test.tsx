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
			options: { tolerance: 0, unplannedPolicy: "isolate" },
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
			options: { tolerance: 0, unplannedPolicy: "isolate" },
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
});
