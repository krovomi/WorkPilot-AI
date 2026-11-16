/**
 * The app-wide task and roadmap listeners: task events are batched per frame
 * (a phase change goes through at once), filtered to the open project, and
 * the rate-limit and auth-failure events open their modals.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";

const queue = vi.hoisted(() => ({ loadTasks: vi.fn(), kickQueue: vi.fn() }));
vi.mock("../../stores/task-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../stores/task-store")>()),
	loadTasks: queue.loadTasks,
	kickQueue: queue.kickQueue,
}));

import { useAuthStore } from "../../stores/auth-store";
import { useProjectStore } from "../../stores/project-store";
import { useRoadmapStore } from "../../stores/roadmap-store";
import { useTaskStore } from "../../stores/task-store";
import { useIpcListeners } from "../useIpc";

type Listener = (...args: unknown[]) => void;
let listeners: Map<string, Listener>;
const emit = (name: string, ...args: unknown[]) => act(() => listeners.get(name)?.(...args));

const actions = {
	updateTaskFromPlan: vi.fn(),
	updateTaskStatus: vi.fn(),
	updateExecutionProgress: vi.fn(),
	appendLog: vi.fn(),
	batchAppendLogs: vi.fn(),
	setError: vi.fn(),
	setPipelineStatus: vi.fn(),
};

const INITIAL_TASKS = useTaskStore.getState();
const INITIAL_ROADMAP = useRoadmapStore.getState();
const INITIAL_AUTH = useAuthStore.getState();

beforeEach(() => {
	vi.useFakeTimers();
	listeners = new Map();
	(window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(
		{},
		{
			get: (_t, name: string) => (callback: Listener) => {
				listeners.set(name, callback);
				return () => listeners.delete(name);
			},
		},
	);
	for (const fn of [...Object.values(actions), ...Object.values(queue)]) fn.mockReset();
	queue.loadTasks.mockResolvedValue(undefined);
	useTaskStore.setState({
		...INITIAL_TASKS,
		...actions,
		tasks: [{ id: "t1", specId: "001-a", executionProgress: { phase: "coding" } } as unknown as Task],
	});
	useProjectStore.setState({ selectedProjectId: "p1" });
	useRoadmapStore.setState({ ...INITIAL_ROADMAP, currentProjectId: "p1" });
	useAuthStore.setState(INITIAL_AUTH, true);
});

afterEach(() => {
	vi.useRealTimers();
	useTaskStore.setState(INITIAL_TASKS, true);
});

describe("task events batched per frame", () => {
	it("applies plan, status, progress and logs of one task together after 16 ms", () => {
		renderHook(() => useIpcListeners());
		const plan = { phases: [] };
		emit("onTaskProgress", "t1", plan, "p1");
		emit("onTaskStatusChange", "t1", "human_review", "p1", "completed", undefined);
		emit("onTaskExecutionProgress", "t1", { phase: "coding", overallProgress: 40 }, "p1");
		emit("onTaskLog", "t1", "line 1", "p1");
		emit("onTaskLog", "t1", "line 2", "p1");
		expect(actions.updateTaskFromPlan).not.toHaveBeenCalled();

		act(() => vi.advanceTimersByTime(16));
		expect(actions.updateTaskFromPlan).toHaveBeenCalledWith("t1", plan);
		expect(actions.updateTaskStatus).toHaveBeenCalledWith("t1", "human_review", "completed", undefined);
		expect(actions.updateExecutionProgress).toHaveBeenCalledWith("t1", { phase: "coding", overallProgress: 40 });
		expect(actions.batchAppendLogs).toHaveBeenCalledWith("t1", ["line 1", "line 2"]);
	});

	it("applies a phase change at once, after what was already queued", () => {
		renderHook(() => useIpcListeners());
		emit("onTaskLog", "t1", "before", "p1");
		emit("onTaskExecutionProgress", "t1", { phase: "qa_review" }, "p1");
		expect(actions.batchAppendLogs).toHaveBeenCalledWith("t1", ["before"]);
		expect(actions.updateExecutionProgress).toHaveBeenCalledWith("t1", { phase: "qa_review" });
		expect(actions.batchAppendLogs.mock.invocationCallOrder[0]).toBeLessThan(
			actions.updateExecutionProgress.mock.invocationCallOrder[0],
		);
	});

	it("batches ticks of the phase a task is already in, found by id or spec id", () => {
		window.DEBUG = true;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		renderHook(() => useIpcListeners());
		emit("onTaskExecutionProgress", "001-a", { phase: "coding", overallProgress: 10 }, "p1");
		emit("onTaskExecutionProgress", "t1", { phase: "coding", overallProgress: 20 }, "p1");
		expect(actions.updateExecutionProgress).not.toHaveBeenCalled();
		emit("onTaskExecutionProgress", "t1", { phase: "coding", overallProgress: 30 }, "p1");
		act(() => vi.advanceTimersByTime(16));
		// One update per id the events used, carrying the last tick of each.
		expect(actions.updateExecutionProgress.mock.calls).toEqual([
			["001-a", { phase: "coding", overallProgress: 10 }],
			["t1", { phase: "coding", overallProgress: 30 }],
		]);
		expect(warn).not.toHaveBeenCalled();

		emit("onTaskExecutionProgress", "001-a", { phase: "planning" }, "p1");
		expect(actions.updateExecutionProgress).toHaveBeenLastCalledWith("001-a", { phase: "planning" });
		expect(warn).toHaveBeenCalledOnce();
		window.DEBUG = false;
		warn.mockRestore();
	});

	it("flushes what is queued when the listeners go away", () => {
		const { unmount } = renderHook(() => useIpcListeners());
		emit("onTaskLog", "t1", "last words", "p1");
		unmount();
		expect(actions.batchAppendLogs).toHaveBeenCalledWith("t1", ["last words"]);
		expect(listeners.size).toBe(0);
	});

	it("ignores the events of another project, accepts those that name none", () => {
		renderHook(() => useIpcListeners());
		emit("onTaskStatusChange", "t1", "done", "p2");
		emit("onTaskProgress", "t1", {}, "p2");
		emit("onTaskExecutionProgress", "t1", { phase: "coding" }, "p2");
		emit("onTaskLog", "t1", "x", "p2");
		emit("onTaskError", "t1", "x", "p2");
		act(() => vi.advanceTimersByTime(16));
		expect(actions.updateTaskStatus).not.toHaveBeenCalled();
		expect(actions.setError).not.toHaveBeenCalled();

		emit("onTaskStatusChange", "t1", "done");
		act(() => vi.advanceTimersByTime(16));
		expect(actions.updateTaskStatus).toHaveBeenCalledOnce();

		useProjectStore.setState({ selectedProjectId: null });
		emit("onTaskStatusChange", "t1", "in_progress", "p9");
		act(() => vi.advanceTimersByTime(16));
		expect(actions.updateTaskStatus).toHaveBeenCalledTimes(2);
	});

	it("shows a task error at once and logs it", () => {
		renderHook(() => useIpcListeners());
		emit("onTaskError", "t1", "No API key", "p1");
		expect(actions.setError).toHaveBeenCalledWith("Task t1: No API key");
		expect(actions.appendLog).toHaveBeenCalledWith("t1", "[ERROR] No API key");
	});
});

describe("task updates, splits and pipelines", () => {
	it("ignores an update for a task it does not know", () => {
		const updateTask = vi.fn();
		useTaskStore.setState({ updateTask });
		renderHook(() => useIpcListeners());
		emit("onTaskUpdated", "nope", { prUrl: "x" }, "p1");
		emit("onTaskUpdated", "t1", { prUrl: "x" }, "p2");
		expect(updateTask).not.toHaveBeenCalled();
		emit("onTaskUpdated", "001-a", { prUrl: "x" }, "p1");
		expect(updateTask).toHaveBeenCalledWith("t1", { prUrl: "x" });
	});

	it("reloads the board after a split, then starts the queue", async () => {
		renderHook(() => useIpcListeners());
		emit("onTaskSplit", "t1", "p1");
		await act(async () => {
			await Promise.resolve();
		});
		expect(queue.loadTasks).toHaveBeenCalledWith("p1", { forceRefresh: true });
		expect(queue.kickQueue).toHaveBeenCalled();

		emit("onTaskSplit", "t1");
		emit("onTaskSplit", "t1", "p2");
		expect(queue.loadTasks).toHaveBeenCalledOnce();
	});

	it("passes the CI status of the open project's tasks to the board", () => {
		renderHook(() => useIpcListeners());
		emit("onPipelineStatus", { projectId: "p2", taskId: "t1" });
		expect(actions.setPipelineStatus).not.toHaveBeenCalled();
		emit("onPipelineStatus", { projectId: "p1", taskId: "t1", state: "failed" });
		expect(actions.setPipelineStatus).toHaveBeenCalledWith({ projectId: "p1", taskId: "t1", state: "failed" });
	});
});

describe("roadmap events", () => {
	const roadmap = () => useRoadmapStore.getState();

	it.each([true, false])("follows the open project's generation (debug %s)", (debug) => {
		window.DEBUG = debug;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		renderHook(() => useIpcListeners());

		emit("onRoadmapProgress", "p1", { phase: "analyzing", progress: 30, message: "…" });
		expect(roadmap().generationStatus).toMatchObject({ phase: "analyzing", progress: 30 });

		emit("onRoadmapComplete", "p1", { features: [{}], phases: [] });
		expect(roadmap().roadmap).toEqual({ features: [{}], phases: [] });
		expect(roadmap().generationStatus).toMatchObject({ phase: "complete", progress: 100 });

		emit("onRoadmapError", "p1", "quota");
		expect(roadmap().generationStatus).toMatchObject({ phase: "error", error: "quota" });

		emit("onRoadmapStopped", "p1");
		expect(roadmap().generationStatus).toMatchObject({ phase: "idle", message: "Generation stopped" });

		expect(warn.mock.calls.length > 0).toBe(debug);
		expect(error.mock.calls.length > 0).toBe(debug);
		window.DEBUG = false;
		warn.mockRestore();
		error.mockRestore();
	});

	it("ignores the generation of another project", () => {
		renderHook(() => useIpcListeners());
		const before = roadmap().generationStatus;
		emit("onRoadmapProgress", "p2", { phase: "analyzing", progress: 30, message: "" });
		emit("onRoadmapComplete", "p2", {});
		emit("onRoadmapError", "p2", "x");
		emit("onRoadmapStopped", "p2");
		expect(roadmap().generationStatus).toEqual(before);
		expect(roadmap().roadmap).toBe(INITIAL_ROADMAP.roadmap);
	});
});

describe("rate limits and auth failures", () => {
	const auth = () => useAuthStore.getState();

	it("opens the terminal rate-limit modal, with the date as a Date", () => {
		renderHook(() => useIpcListeners());
		emit("onTerminalRateLimit", { resetTime: "3pm", detectedAt: "2026-11-15T10:00:00Z" });
		expect(auth().rateLimit_isModalOpen).toBe(true);
		expect(auth().rateLimit_info?.detectedAt).toEqual(new Date("2026-11-15T10:00:00Z"));

		const at = new Date(0);
		emit("onTerminalRateLimit", { resetTime: "4pm", detectedAt: at });
		expect(auth().rateLimit_info?.detectedAt).toBe(at);
	});

	it("opens the SDK rate-limit modal", () => {
		renderHook(() => useIpcListeners());
		emit("onSDKRateLimit", { source: "roadmap", detectedAt: "2026-11-15T10:00:00Z" });
		expect(auth().rateLimit_isSDKModalOpen).toBe(true);
		expect(auth().rateLimit_sdkInfo?.detectedAt).toBeInstanceOf(Date);
		const at = new Date(1);
		emit("onSDKRateLimit", { source: "roadmap", detectedAt: at });
		expect(auth().rateLimit_sdkInfo?.detectedAt).toBe(at);
	});

	it("opens the re-authentication modal", () => {
		renderHook(() => useIpcListeners());
		emit("onAuthFailure", { profileId: "p", detectedAt: "2026-11-15T10:00:00Z" });
		expect(auth().authFailure_isModalOpen).toBe(true);
		expect(auth().authFailure_info?.detectedAt).toBeInstanceOf(Date);
		const at = new Date(2);
		emit("onAuthFailure", { profileId: "p", detectedAt: at });
		expect(auth().authFailure_info?.detectedAt).toBe(at);
	});
});
