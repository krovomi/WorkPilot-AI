/**
 * The task store's actions toward the main process (create, review, status,
 * edit, delete and undo, archive, abandon, plan, pause) and the store updates
 * the board relies on: status listeners, the queue kick, out-of-order progress
 * and the creation draft.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskDraft, TaskStatus } from "../../../shared/types";
import { CARD_EDIT_CONFLICT } from "../../../shared/types/team-room";
import {
	abandonTask,
	archiveTasks,
	checkTaskRunning,
	clearDraft,
	clearTaskActivity,
	createTask,
	deleteTask,
	deleteTasks,
	duplicateTask,
	forceCompleteTask,
	getTaskProgress,
	hasRecentActivity,
	isDraftEmpty,
	isIncompleteHumanReview,
	kickQueue,
	loadDraft,
	loadTasks,
	onQueueKick,
	pauseTask,
	persistTaskStatus,
	persistUpdateTask,
	recordTaskActivity,
	recoverStuckTask,
	resetTask,
	restoreTask,
	resumeAbandonedTask,
	resumeTask,
	saveDraft,
	saveTaskEdit,
	startTask,
	stopTask,
	submitReview,
	updatePlanSubtasks,
	useTaskStore,
} from "../task-store";

const api = {
	getTasks: vi.fn(),
	createTask: vi.fn(),
	duplicateTask: vi.fn(),
	startTask: vi.fn(),
	stopTask: vi.fn(),
	submitReview: vi.fn(),
	updateTaskStatus: vi.fn(),
	updateTask: vi.fn(),
	checkTaskRunning: vi.fn(),
	recoverStuckTask: vi.fn(),
	deleteTask: vi.fn(),
	archiveTasks: vi.fn(),
	updatePlanSubtasks: vi.fn(),
	resetTask: vi.fn(),
	invoke: vi.fn(),
};

function task(id: string, overrides: Partial<Task> = {}): Task {
	return {
		id,
		specId: `spec-${id}`,
		projectId: "p1",
		title: id,
		description: `about ${id}`,
		status: "backlog" as TaskStatus,
		subtasks: [],
		logs: [],
		createdAt: new Date("2026-11-01"),
		updatedAt: new Date("2026-11-01"),
		...overrides,
	} as Task;
}

const store = () => useTaskStore.getState();
const INITIAL = useTaskStore.getState();

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	useTaskStore.setState(INITIAL, true);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	localStorage.clear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("loading and creating", () => {
	it("keeps the error of a failed load, or of a thrown one", async () => {
		api.getTasks.mockResolvedValue({ success: false });
		await loadTasks("p1");
		expect(store().error).toBe("Failed to load tasks");
		api.getTasks.mockRejectedValue(new Error("ipc down"));
		await loadTasks("p1");
		expect(store()).toMatchObject({ error: "ipc down", isLoading: false });
		api.getTasks.mockRejectedValue("x");
		await loadTasks("p1");
		expect(store().error).toBe("Unknown error");
	});

	it("adds a created task, or keeps why it was refused", async () => {
		api.createTask.mockResolvedValue({ success: true, data: task("t1") });
		expect((await createTask("p1", "T", "D", { priority: "high" } as never))?.id).toBe("t1");
		expect(api.createTask).toHaveBeenCalledWith("p1", "T", "D", { priority: "high" });
		expect(store().tasks.map((t) => t.id)).toEqual(["t1"]);

		api.createTask.mockResolvedValue({ success: false, error: "no spec dir" });
		expect(await createTask("p1", "T", "D")).toBeNull();
		expect(store().error).toBe("no spec dir");
		api.createTask.mockResolvedValue({ success: false });
		await createTask("p1", "T", "D");
		expect(store().error).toBe("Failed to create task");
		api.createTask.mockRejectedValue(new Error("boom"));
		expect(await createTask("p1", "T", "D")).toBeNull();
		expect(store().error).toBe("boom");
		api.createTask.mockRejectedValue(1);
		await createTask("p1", "T", "D");
		expect(store().error).toBe("Unknown error");
	});

	it("duplicates a task into the board", async () => {
		api.duplicateTask.mockResolvedValue({ success: true, data: task("copy") });
		expect(await duplicateTask("t1", "T (copy)")).toEqual({
			success: true,
			task: task("copy"),
		});
		expect(api.duplicateTask).toHaveBeenCalledWith("t1", "T (copy)");
		expect(store().tasks.map((t) => t.id)).toEqual(["copy"]);

		api.duplicateTask.mockResolvedValue({ success: false, error: "gone" });
		expect(await duplicateTask("t1")).toEqual({ success: false, error: "gone" });
		api.duplicateTask.mockResolvedValue({ success: false });
		await duplicateTask("t1");
		expect(store().error).toBe("Failed to duplicate task");
		api.duplicateTask.mockRejectedValue(new Error("x"));
		expect(await duplicateTask("t1")).toEqual({ success: false, error: "x" });
		api.duplicateTask.mockRejectedValue(null);
		expect((await duplicateTask("t1")).error).toBe("Unknown error");
	});

	it("starts and stops through the main process", () => {
		startTask("t1", { parallel: true, workers: 2 });
		stopTask("t1");
		expect(api.startTask).toHaveBeenCalledWith("t1", { parallel: true, workers: 2 });
		expect(api.stopTask).toHaveBeenCalledWith("t1");
	});
});

describe("review and status", () => {
	it("submits a review and says whether it was taken", async () => {
		api.submitReview.mockResolvedValue({ success: true });
		expect(await submitReview("t1", false, "fix it", [], ["c1"])).toBe(true);
		expect(api.submitReview).toHaveBeenCalledWith("t1", false, "fix it", [], ["c1"]);
		api.submitReview.mockResolvedValue({ success: false });
		expect(await submitReview("t1", true)).toBe(false);
		api.submitReview.mockRejectedValue(new Error("x"));
		expect(await submitReview("t1", true)).toBe(false);
	});

	it("changes the status locally only once the main process saved it", async () => {
		useTaskStore.setState({ tasks: [task("t1")] });
		api.updateTaskStatus.mockResolvedValue({ success: false, error: "locked" });
		expect(await persistTaskStatus("t1", "done")).toEqual({
			success: false,
			error: "locked",
		});
		expect(store().tasks[0].status).toBe("backlog");

		api.updateTaskStatus.mockResolvedValue({ success: true });
		expect(await persistTaskStatus("t1", "queue", { skipPrCreation: true })).toEqual({
			success: true,
		});
		expect(api.updateTaskStatus).toHaveBeenLastCalledWith("t1", "queue", {
			skipPrCreation: true,
		});
		expect(store().tasks[0].status).toBe("queue");

		api.updateTaskStatus.mockRejectedValue(new Error("x"));
		expect(await persistTaskStatus("t1", "done")).toEqual({
			success: false,
			error: "Error: x",
		});
	});

	it("asks before deleting a worktree, then forces the cleanup", async () => {
		useTaskStore.setState({ tasks: [task("t1", { status: "human_review" })] });
		api.updateTaskStatus.mockResolvedValueOnce({
			success: false,
			worktreeExists: true,
			worktreePath: "/wt/t1",
			error: "worktree",
		});
		expect(await persistTaskStatus("t1", "done")).toEqual({
			success: false,
			worktreeExists: true,
			worktreePath: "/wt/t1",
			error: "worktree",
		});
		api.updateTaskStatus.mockResolvedValueOnce({ success: true });
		expect(await forceCompleteTask("t1")).toEqual({ success: true });
		expect(api.updateTaskStatus).toHaveBeenLastCalledWith("t1", "done", {
			forceCleanup: true,
		});
		expect(store().tasks[0].status).toBe("done");
	});

	it("tells status listeners what changed, after the update", async () => {
		useTaskStore.setState({ tasks: [task("t1")] });
		const seen: unknown[] = [];
		const off = store().registerTaskStatusChangeListener((...args) => seen.push(args));
		const broken = store().registerTaskStatusChangeListener(() => {
			throw new Error("listener bug");
		});
		store().updateTaskStatus("t1", "in_progress");
		expect(seen).toEqual([]);
		await Promise.resolve();
		expect(seen).toEqual([["t1", "backlog", "in_progress"]]);
		expect(store().tasks[0].executionProgress?.phase).toBe("planning");
		expect(console.error).toHaveBeenCalledWith(
			"[TaskStore] Error in task status change listener:",
			expect.any(Error),
		);

		store().updateTaskStatus("t1", "in_progress");
		store().updateTaskStatus("missing", "done");
		await Promise.resolve();
		expect(seen).toHaveLength(1);
		store().updateTaskStatus("t1", "backlog");
		expect(store().tasks[0].executionProgress).toEqual({
			phase: "idle",
			phaseProgress: 0,
			overallProgress: 0,
		});
		off();
		broken();
	});

	it("checks whether a task still runs", async () => {
		api.checkTaskRunning.mockResolvedValue({ success: true, data: true });
		expect(await checkTaskRunning("t1")).toBe(true);
		api.checkTaskRunning.mockResolvedValue({ success: true, data: false });
		expect(await checkTaskRunning("t1")).toBe(false);
		api.checkTaskRunning.mockRejectedValue(new Error("x"));
		expect(await checkTaskRunning("t1")).toBe(false);
	});

	it("recovers a stuck task, restarting it unless told otherwise", async () => {
		api.recoverStuckTask.mockResolvedValue({
			success: true,
			data: { message: "restarted", autoRestarted: true },
		});
		expect(await recoverStuckTask("t1")).toEqual({
			success: true,
			message: "restarted",
			autoRestarted: true,
		});
		expect(api.recoverStuckTask).toHaveBeenCalledWith("t1", { autoRestart: true });
		await recoverStuckTask("t1", { autoRestart: false, targetStatus: "backlog" });
		expect(api.recoverStuckTask).toHaveBeenLastCalledWith("t1", {
			autoRestart: false,
			targetStatus: "backlog",
		});
		api.recoverStuckTask.mockResolvedValue({ success: false, error: "no plan" });
		expect(await recoverStuckTask("t1")).toEqual({ success: false, message: "no plan" });
		api.recoverStuckTask.mockResolvedValue({ success: false });
		expect((await recoverStuckTask("t1")).message).toBe("Failed to recover task");
		api.recoverStuckTask.mockRejectedValue(new Error("x"));
		expect(await recoverStuckTask("t1")).toEqual({ success: false, message: "x" });
		api.recoverStuckTask.mockRejectedValue("x");
		expect((await recoverStuckTask("t1")).message).toBe("Unknown error");
	});
});

describe("editing", () => {
	it("keeps the saved title, description and metadata", async () => {
		useTaskStore.setState({ tasks: [task("t1")] });
		api.updateTask.mockResolvedValue({
			success: true,
			data: { title: "New", description: "Desc", metadata: { priority: "low" } },
		});
		expect(await saveTaskEdit("t1", { title: "New" })).toEqual({ saved: true });
		expect(store().tasks[0]).toMatchObject({
			title: "New",
			description: "Desc",
			metadata: { priority: "low" },
		});
		expect(await persistUpdateTask("t1", { description: "Desc" })).toBe(true);
	});

	it("returns a teammate's conflicting fields instead of overwriting them", async () => {
		const conflicts = [{ field: "title", theirs: "B", mine: "A" }];
		api.updateTask.mockResolvedValue({
			success: false,
			error: CARD_EDIT_CONFLICT,
			conflicts,
		});
		expect(
			await saveTaskEdit("t1", { title: "A", base: { title: "O", description: "" } }),
		).toEqual({ saved: false, conflicts });
		api.updateTask.mockResolvedValue({ success: false, error: CARD_EDIT_CONFLICT, conflicts: [] });
		expect(await saveTaskEdit("t1", { title: "A" })).toEqual({ saved: false });
		api.updateTask.mockResolvedValue({ success: false, error: "disk" });
		expect(await persistUpdateTask("t1", { title: "A" })).toBe(false);
		api.updateTask.mockRejectedValue(new Error("x"));
		expect(await saveTaskEdit("t1", { title: "A" })).toEqual({ saved: false });
	});
});

describe("deleting and undo", () => {
	it("deletes one task by id or spec id and clears the selection", async () => {
		useTaskStore.setState({ tasks: [task("t1"), task("t2")], selectedTaskId: "spec-t1" });
		api.deleteTask.mockResolvedValue({ success: true });
		expect(await deleteTask("spec-t1")).toEqual({ success: true });
		expect(store().tasks.map((t) => t.id)).toEqual(["t2"]);
		expect(store().selectedTaskId).toBeNull();

		api.deleteTask.mockResolvedValue({ success: false, error: "busy" });
		expect(await deleteTask("t2")).toEqual({ success: false, error: "busy" });
		api.deleteTask.mockResolvedValue({ success: false });
		expect((await deleteTask("t2")).error).toBe("Failed to delete task");
		api.deleteTask.mockRejectedValue(new Error("x"));
		expect(await deleteTask("t2")).toEqual({ success: false, error: "x" });
		api.deleteTask.mockRejectedValue(0);
		expect((await deleteTask("t2")).error).toBe("Unknown error");
		expect(store().tasks.map((t) => t.id)).toEqual(["t2"]);
	});

	it("deletes several tasks, keeping those the main process refused", async () => {
		useTaskStore.setState({
			tasks: [task("a"), task("b"), task("c")],
			selectedTaskId: "a",
		});
		api.deleteTask.mockImplementation(async (id: string) => ({ success: id !== "b" }));
		expect(await deleteTasks(["a", "b"])).toEqual({
			success: false,
			error: "Failed to delete 1 task(s)",
			failedIds: ["b"],
		});
		expect(store().tasks.map((t) => t.id)).toEqual(["b", "c"]);
		expect(store().selectedTaskId).toBeNull();
		expect(await restoreTask("b")).toEqual({
			success: false,
			error: "Task backup not found or expired",
		});

		api.deleteTask.mockRejectedValue(new Error("x"));
		expect(await deleteTasks(["c"])).toEqual({ success: false, error: "x" });
		api.deleteTask.mockRejectedValue("x");
		expect((await deleteTasks(["c"])).error).toBe("Unknown error");
	});

	it("restores a deleted task by creating it again", async () => {
		const deleted = task("a", { metadata: { priority: "high" } as never });
		useTaskStore.setState({ tasks: [deleted] });
		api.deleteTask.mockResolvedValue({ success: true });
		expect(await deleteTasks(["a"])).toEqual({ success: true });

		api.createTask.mockResolvedValueOnce({ success: false, error: "disk" });
		expect(await restoreTask("a")).toEqual({ success: false, error: "disk" });
		api.createTask.mockResolvedValueOnce({ success: false });
		expect((await restoreTask("a")).error).toBe("Failed to restore task in backend");

		api.createTask.mockResolvedValueOnce({ success: true, data: task("a2") });
		api.getTasks.mockResolvedValue({ success: true, data: [task("a2")] });
		expect(await restoreTask("a")).toEqual({ success: true });
		expect(api.createTask).toHaveBeenLastCalledWith("p1", "a", "about a", {
			priority: "high",
		});
		expect(store().tasks.map((t) => t.id)).toEqual(["a2"]);
		expect((await restoreTask("a")).success).toBe(false);
	});

	it("restores with empty fields, and refuses a task without a project", async () => {
		useTaskStore.setState({
			tasks: [
				task("bare", { description: "", metadata: undefined }),
				task("orphan", { projectId: "" }),
			],
		});
		api.deleteTask.mockResolvedValue({ success: true });
		await deleteTasks(["bare", "orphan", "unknown"]);
		api.createTask.mockResolvedValue({ success: true, data: task("x") });
		api.getTasks.mockResolvedValue({ success: true, data: [] });
		await restoreTask("bare");
		expect(api.createTask).toHaveBeenCalledWith("p1", "bare", "", {});
		expect(await restoreTask("orphan")).toEqual({
			success: false,
			error: "No project ID found for task restoration",
		});
		api.createTask.mockRejectedValue(new Error("x"));
		useTaskStore.setState({ tasks: [task("again")] });
		await deleteTasks(["again"]);
		expect(await restoreTask("again")).toEqual({ success: false, error: "x" });
	});

	it("forgets a deleted task after five minutes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
		useTaskStore.setState({ tasks: [task("a")] });
		api.deleteTask.mockResolvedValue({ success: true });
		await deleteTasks(["a"]);
		vi.setSystemTime(new Date("2026-11-14T10:05:01Z"));
		expect(await restoreTask("a")).toEqual({
			success: false,
			error: "Task backup not found or expired",
		});
		expect(api.createTask).not.toHaveBeenCalled();
	});

	it("archives and reloads the board", async () => {
		api.archiveTasks.mockResolvedValue({ success: true });
		api.getTasks.mockResolvedValue({ success: true, data: [] });
		expect(await archiveTasks("p1", ["a"], "1.2.0")).toEqual({ success: true });
		expect(api.archiveTasks).toHaveBeenCalledWith("p1", ["a"], "1.2.0");
		expect(api.getTasks).toHaveBeenCalled();
		api.archiveTasks.mockResolvedValue({ success: false, error: "e" });
		expect(await archiveTasks("p1", ["a"])).toEqual({ success: false, error: "e" });
		api.archiveTasks.mockResolvedValue({ success: false });
		expect((await archiveTasks("p1", ["a"])).error).toBe("Failed to archive tasks");
		api.archiveTasks.mockRejectedValue(new Error("x"));
		expect(await archiveTasks("p1", ["a"])).toEqual({ success: false, error: "x" });
		api.archiveTasks.mockRejectedValue("x");
		expect((await archiveTasks("p1", ["a"])).error).toBe("Unknown error");
	});
});

describe("abandon and resume", () => {
	it("stops a running task before abandoning it, and keeps its metadata", async () => {
		useTaskStore.setState({
			tasks: [task("t1", { status: "in_progress", metadata: { priority: "high" } as never })],
		});
		api.updateTask.mockResolvedValue({ success: true });
		expect(await abandonTask("t1", "  not needed  ")).toEqual({ success: true });
		expect(api.stopTask).toHaveBeenCalledWith("t1");
		const sent = api.updateTask.mock.calls[0][1].metadata;
		expect(sent).toMatchObject({ abandoned: true, abandonedReason: "not needed" });
		expect(store().tasks[0].metadata).toMatchObject({ priority: "high", abandoned: true });

		expect(await resumeAbandonedTask("t1")).toEqual({ success: true });
		expect(store().tasks[0].metadata).toMatchObject({ priority: "high", abandoned: false });
	});

	it("does not stop an idle task, and reports refusals", async () => {
		useTaskStore.setState({ tasks: [task("t1", { status: "human_review" })] });
		api.updateTask.mockResolvedValue({ success: false, error: "ro" });
		expect(await abandonTask("t1")).toEqual({ success: false, error: "ro" });
		expect(api.stopTask).not.toHaveBeenCalled();
		expect(await resumeAbandonedTask("t1")).toEqual({ success: false, error: "ro" });
		api.updateTask.mockResolvedValue({ success: false });
		expect((await abandonTask("t1")).error).toBe("Failed to abandon task");
		expect((await resumeAbandonedTask("t1")).error).toBe("Failed to resume task");
		api.updateTask.mockRejectedValue(new Error("x"));
		expect(await abandonTask("unknown")).toEqual({ success: false, error: "x" });
		expect(await resumeAbandonedTask("unknown")).toEqual({ success: false, error: "x" });
		api.updateTask.mockRejectedValue(1);
		expect((await abandonTask("t1")).error).toBe("Unknown error");
		expect((await resumeAbandonedTask("t1")).error).toBe("Unknown error");
	});

	it("applies the patch to a task it does not know without metadata", async () => {
		api.updateTask.mockResolvedValue({ success: true });
		expect(await abandonTask("unknown")).toEqual({ success: true });
		expect(await resumeAbandonedTask("unknown")).toEqual({ success: true });
		expect(store().tasks).toEqual([]);
	});
});

describe("plan, reset, pause and resume", () => {
	it("saves the edited plan", async () => {
		api.updatePlanSubtasks.mockResolvedValue({ success: true });
		expect(await updatePlanSubtasks("t1", [{ id: "p" }])).toBe(true);
		expect(api.updatePlanSubtasks).toHaveBeenCalledWith("t1", [{ id: "p" }]);
		api.updatePlanSubtasks.mockResolvedValue({ success: false, error: "x" });
		expect(await updatePlanSubtasks("t1", [])).toBe(false);
	});

	it("resets a task to the backlog state the main process returns", async () => {
		useTaskStore.setState({ tasks: [task("t1", { status: "human_review" })] });
		api.resetTask.mockResolvedValue({ success: true, data: { status: "backlog", subtasks: [] } });
		expect(await resetTask("t1")).toEqual({ success: true });
		expect(store().tasks[0].status).toBe("backlog");
		api.resetTask.mockResolvedValue({ success: false, error: "e" });
		expect(await resetTask("t1")).toEqual({ success: false, error: "e" });
		api.resetTask.mockRejectedValue(new Error("x"));
		expect(await resetTask("t1")).toEqual({ success: false, error: "Error: x" });
	});

	it("marks a paused task with its subtask and model, then resumes it", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
		useTaskStore.setState({
			tasks: [task("t1", { metadata: { provider: "openai", model: "gpt-x" } as never })],
		});
		api.invoke.mockResolvedValue({ success: true });
		expect(await pauseTask("t1", "s2")).toBe(true);
		expect(api.invoke).toHaveBeenCalledWith("TASK_PAUSE", "t1", "s2");
		expect(store().tasks[0].metadata?.paused).toEqual({
			enabled: true,
			paused_at: "2026-11-14T10:00:00.000Z",
			paused_subtask_id: "s2",
			provider: "openai",
			model: "gpt-x",
		});
		expect(await resumeTask("t1")).toBe(true);
		expect(api.invoke).toHaveBeenLastCalledWith("TASK_RESUME", "t1");
		expect(store().tasks[0].metadata?.paused).toEqual({
			enabled: false,
			paused_at: null,
			paused_subtask_id: null,
			provider: "openai",
			model: "gpt-x",
		});
	});

	it("falls back to the default model, and reports a refused pause", async () => {
		useTaskStore.setState({ tasks: [task("t1")] });
		api.invoke.mockResolvedValue({ success: true });
		await pauseTask("t1");
		expect(store().tasks[0].metadata?.paused).toMatchObject({
			paused_subtask_id: null,
			provider: "anthropic",
			model: "claude-opus-4-7",
		});
		useTaskStore.setState({ tasks: [task("t1")] });
		await resumeTask("t1");
		expect(store().tasks[0].metadata?.paused).toMatchObject({
			provider: "anthropic",
			model: "claude-opus-4-7",
		});
		expect(await pauseTask("unknown")).toBe(true);
		expect(await resumeTask("unknown")).toBe(true);

		api.invoke.mockResolvedValue({ success: false, error: "no run" });
		expect(await pauseTask("t1")).toBe(false);
		expect(await resumeTask("t1")).toBe(false);
		api.invoke.mockResolvedValue(undefined);
		expect(await pauseTask("t1")).toBe(false);
		expect(await resumeTask("t1")).toBe(false);
	});
});

describe("board helpers", () => {
	it("kicks every registered queue, surviving a broken one", () => {
		const kicked = vi.fn();
		const offBroken = onQueueKick(() => {
			throw new Error("x");
		});
		const off = onQueueKick(kicked);
		kickQueue();
		expect(kicked).toHaveBeenCalledTimes(1);
		expect(console.error).toHaveBeenCalledWith(
			"[TaskStore] Error in queue kick listener:",
			expect.any(Error),
		);
		off();
		offBroken();
		kickQueue();
		expect(kicked).toHaveBeenCalledTimes(1);
	});

	it("counts a task active for a minute after its last activity", () => {
		vi.useFakeTimers();
		expect(hasRecentActivity("t9")).toBe(false);
		recordTaskActivity("t9");
		vi.advanceTimersByTime(59_000);
		expect(hasRecentActivity("t9")).toBe(true);
		vi.advanceTimersByTime(2_000);
		expect(hasRecentActivity("t9")).toBe(false);
		recordTaskActivity("t9");
		clearTaskActivity("t9");
		expect(hasRecentActivity("t9")).toBe(false);
	});

	it("drops an out-of-order progress update", () => {
		useTaskStore.setState({ tasks: [task("t1", { status: "in_progress" })] });
		store().updateExecutionProgress("t1", { phase: "coding", sequenceNumber: 5 });
		store().updateExecutionProgress("t1", { phase: "planning", sequenceNumber: 3 });
		expect(store().tasks[0].executionProgress).toMatchObject({
			phase: "coding",
			sequenceNumber: 5,
		});
		store().updateExecutionProgress("missing", { phase: "coding" });
		expect(store().tasks).toHaveLength(1);
	});

	it("replaces a timestamp used as a sequence number", () => {
		useTaskStore.setState({
			tasks: [
				task("t1", {
					status: "in_progress",
					executionProgress: {
						phase: "coding",
						phaseProgress: 0,
						overallProgress: 0,
						sequenceNumber: 1_731_000_000_000,
					},
				}),
			],
		});
		store().updateExecutionProgress("t1", { phase: "qa_review", sequenceNumber: 2 });
		expect(store().tasks[0].executionProgress).toMatchObject({
			phase: "qa_review",
			sequenceNumber: 2,
		});
	});

	it("selects, spotlights and filters tasks", () => {
		useTaskStore.setState({ tasks: [task("t1"), task("t2", { status: "done" })] });
		store().selectTask("t2");
		expect(store().getSelectedTask()?.id).toBe("t2");
		store().jumpToTask("t1");
		expect(store().jumpToTaskId).toBe("t1");
		store().clearJump();
		expect(store().jumpToTaskId).toBeNull();
		expect(store().getTasksByStatus("done").map((t) => t.id)).toEqual(["t2"]);
		store().setPipelineStatus({ taskId: "t1", state: "running" } as never);
		expect(store().pipelineStatuses.t1).toEqual({ taskId: "t1", state: "running" });
		store().batchAppendLogs("missing", ["x"]);
		store().clearTasks();
		expect(store()).toMatchObject({ tasks: [], selectedTaskId: null, taskOrder: null });
	});

	it("puts a new task on top of a column the order did not have yet", () => {
		useTaskStore.setState({ taskOrder: { backlog: [] } as never });
		store().addTask(task("t1", { status: "queue" }));
		expect(store().taskOrder?.queue).toEqual(["t1"]);
		store().addTask(task("t2", { status: undefined as never }));
		expect(store().taskOrder?.backlog).toEqual(["t2"]);
		store().reorderTasksInColumn("done", "a", "b");
		expect(store().taskOrder?.done).toBeUndefined();
	});

	it("reports when the order cannot be saved or cleared", () => {
		useTaskStore.setState({ taskOrder: { backlog: ["a"] } as never });
		const storage = localStorage as unknown as {
			_setShouldThrow: (v: boolean, e: Error | null) => void;
		};
		storage._setShouldThrow(true, new Error("quota"));
		try {
			expect(store().saveTaskOrder("p1")).toBe(false);
		} finally {
			storage._setShouldThrow(false, null);
		}
		vi.spyOn(localStorage, "removeItem").mockImplementation(() => {
			throw new Error("x");
		});
		store().clearTaskOrder("p1");
		expect(store().taskOrder).toEqual({ backlog: ["a"] });
		expect(console.error).toHaveBeenCalledWith("Failed to clear task order:", expect.any(Error));
	});
});

describe("progress and review checks", () => {
	const subtasks = (...statuses: string[]) =>
		statuses.map((status, i) => ({ id: `s${i}`, status })) as Task["subtasks"];

	it("counts completed and blocked subtasks as done", () => {
		expect(
			getTaskProgress(task("t", { subtasks: subtasks("completed", "blocked", "pending") })),
		).toEqual({ completed: 2, total: 3, percentage: 67 });
		expect(getTaskProgress(task("t", { subtasks: undefined as never }))).toEqual({
			completed: 0,
			total: 0,
			percentage: 0,
		});
	});

	it("flags a human review whose build never completed a subtask", () => {
		const review = (overrides: Partial<Task>) =>
			isIncompleteHumanReview(task("t", { status: "human_review", ...overrides }));
		expect(isIncompleteHumanReview(task("t", { status: "done" }))).toBe(false);
		expect(review({ reviewReason: "errors" })).toBe(false);
		expect(review({ reviewReason: "stopped" })).toBe(false);
		expect(review({ reviewReason: "plan_review" })).toBe(false);
		expect(review({ subtasks: [] })).toBe(true);
		expect(review({ subtasks: subtasks("pending") })).toBe(true);
		expect(review({ subtasks: subtasks("pending", "completed") })).toBe(false);
	});
});

describe("creation draft", () => {
	const draft = (overrides: Partial<TaskDraft> = {}): TaskDraft =>
		({
			projectId: "p1",
			title: "",
			description: "",
			images: [],
			...overrides,
		}) as TaskDraft;

	it("saves without the image data and loads it back with its date", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
		saveDraft(draft({ title: "T", images: [{ id: "i", data: "base64", thumbnail: "th" }] as never }));
		const loaded = loadDraft("p1");
		expect(loaded?.title).toBe("T");
		expect(loaded?.images).toEqual([{ id: "i", thumbnail: "th" }]);
		expect(loaded?.savedAt).toEqual(new Date("2026-11-14T10:00:00Z"));
		clearDraft("p1");
		expect(loadDraft("p1")).toBeNull();
	});

	it("survives a storage that fails", () => {
		const storage = localStorage as unknown as {
			_setShouldThrow: (v: boolean, e: Error | null) => void;
			setItem: (k: string, v: string) => void;
		};
		storage._setShouldThrow(true, new Error("quota"));
		try {
			saveDraft(draft({ title: "T" }));
		} finally {
			storage._setShouldThrow(false, null);
		}
		expect(console.error).toHaveBeenCalledWith("Failed to save draft:", expect.any(Error));
		storage.setItem("task-creation-draft-p2", "{not json");
		expect(loadDraft("p2")).toBeNull();
		vi.spyOn(localStorage, "removeItem").mockImplementation(() => {
			throw new Error("x");
		});
		clearDraft("p2");
		expect(console.error).toHaveBeenCalledWith("Failed to clear draft:", expect.any(Error));
	});

	it("is empty only without any content", () => {
		expect(isDraftEmpty(null)).toBe(true);
		expect(isDraftEmpty(draft({ title: "  " }))).toBe(true);
		for (const filled of [
			{ title: "T" },
			{ description: "D" },
			{ images: [{}] as never },
			{ category: "feature" },
			{ priority: "high" },
			{ complexity: "small" },
			{ impact: "low" },
			{ acceptanceCriteria: ["works"] },
			{ extraNote: "note" },
		]) {
			expect(isDraftEmpty(draft(filled as Partial<TaskDraft>))).toBe(false);
		}
		expect(isDraftEmpty(draft({ acceptanceCriteria: [], extraNote: " " }))).toBe(true);
	});
});
