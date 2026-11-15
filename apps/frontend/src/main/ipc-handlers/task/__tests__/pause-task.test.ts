/**
 * The Pause button (`TASK_PAUSE`) and the pause "Stop all agents" takes
 * (#353): `pause_state.json` in every spec copy, then the process halted.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../../shared/types";

const found: { task?: Task; project?: Project } = {};
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn),
	},
}));

vi.mock("../shared", () => ({
	findTaskAndProject: () => ({ ...found }),
}));

vi.mock("../../../project-store", () => ({
	projectStore: { invalidateTasksCache: vi.fn() },
}));

vi.mock("../../../worktree-paths", () => ({
	findTaskWorktree: () => null,
}));

vi.mock("../../../app-logger", () => ({
	appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { IPC_CHANNELS } from "../../../../shared/constants";
import type { AgentManager } from "../../../agent";
import { projectStore } from "../../../project-store";
import { pauseTaskNow, registerPauseHandler } from "../pause-task";

let root: string;
let project: Project;
let specDir: string;

function task(): Task {
	return {
		id: "t1",
		specId: "001-a",
		projectId: project.id,
		title: "t1",
		description: "",
		status: "in_progress",
		subtasks: [],
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as unknown as Task;
}

const agents = { haltTask: vi.fn(() => true) };

function pauseState() {
	return JSON.parse(readFileSync(path.join(specDir, "pause_state.json"), "utf-8"));
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "wp-pause-task-"));
	project = { id: "proj-1", name: "P", path: path.join(root, "repo") } as unknown as Project;
	specDir = path.join(project.path, ".workpilot", "specs", "001-a");
	mkdirSync(specDir, { recursive: true });
	found.task = task();
	found.project = project;
	agents.haltTask.mockClear();
	handlers.clear();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("pauseTaskNow", () => {
	it("writes the pause, with its reason, and halts the process", () => {
		const result = pauseTaskNow(agents as unknown as AgentManager, "t1", { reason: "kill_switch" });

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ taskId: "t1", paused: true, specDirs: 1, wasRunning: true });
		expect(result.data?.pausedAt).toBe(pauseState().paused_at);
		expect(pauseState()).toMatchObject({ enabled: true, reason: "kill_switch" });
		expect(agents.haltTask).toHaveBeenCalledWith("t1");
		expect(projectStore.invalidateTasksCache).toHaveBeenCalledWith("proj-1");
	});

	it("writes no reason when none is given", () => {
		expect(pauseTaskNow(agents as unknown as AgentManager, "t1").success).toBe(true);
		expect(pauseState()).not.toHaveProperty("reason");
	});

	it("refuses an unknown task, and a task without its project", () => {
		found.task = undefined;
		expect(pauseTaskNow(agents as unknown as AgentManager, "nope")).toEqual({
			success: false,
			error: "Task not found",
		});
		found.task = task();
		found.project = undefined;
		expect(pauseTaskNow(agents as unknown as AgentManager, "t1").success).toBe(false);
		expect(agents.haltTask).not.toHaveBeenCalled();
	});

	it("refuses a task that has no spec directory", () => {
		rmSync(specDir, { recursive: true, force: true });
		expect(pauseTaskNow(agents as unknown as AgentManager, "t1")).toEqual({
			success: false,
			error: "Spec directory not found",
		});
	});

	it("says so when the pause cannot be written, and halts nothing", () => {
		// A directory where the file goes: the write fails.
		mkdirSync(path.join(specDir, "pause_state.json"));
		expect(pauseTaskNow(agents as unknown as AgentManager, "t1")).toEqual({
			success: false,
			error: "Could not write pause state",
		});
		expect(agents.haltTask).not.toHaveBeenCalled();
	});
});

describe("TASK_PAUSE", () => {
	function pause(...args: unknown[]) {
		registerPauseHandler(agents as unknown as AgentManager);
		const handler = handlers.get(IPC_CHANNELS.TASK_PAUSE);
		if (!handler) throw new Error("TASK_PAUSE not registered");
		return handler({}, ...args) as Promise<{ success: boolean; error?: string }>;
	}

	it("pauses the task and keeps the subtask it stopped on", async () => {
		expect((await pause("t1", "1.2")).success).toBe(true);
		expect(pauseState().paused_subtask_id).toBe("1.2");
	});

	it("reports a halted process that was not running", async () => {
		agents.haltTask.mockReturnValueOnce(false);
		expect((await pause("t1")).success).toBe(true);
	});

	it("ignores a subtask that is not a string, and refuses a task id that is not one", async () => {
		expect((await pause("t1", { $where: 1 })).success).toBe(true);
		expect(pauseState().paused_subtask_id).toBeNull();
		expect(await pause(42)).toEqual({ success: false, error: "Task not found" });
	});

	it("returns the refusal of a task it cannot pause", async () => {
		found.task = undefined;
		expect(await pause("nope")).toEqual({ success: false, error: "Task not found" });
	});

	it("turns an unexpected error into a refusal", async () => {
		vi.mocked(projectStore.invalidateTasksCache).mockImplementationOnce(() => {
			throw new Error("store gone");
		});
		expect(await pause("t1")).toEqual({ success: false, error: "Error: store gone" });
	});
});
