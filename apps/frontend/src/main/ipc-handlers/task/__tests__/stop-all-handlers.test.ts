/**
 * "Stop all agents" (#353): every running task is paused like the Pause button
 * pauses it, with a reason the next launch does not resume; every other agent
 * process is stopped. The spec directories are real: the backend reads the file.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../../shared/types";

const mockProjects: Project[] = [];
const mockTasksByProject: Map<string, Task[]> = new Map();

const handlers = new Map<string, () => Promise<unknown>>();

vi.mock("electron", () => ({
	ipcMain: { handle: (channel: string, fn: () => Promise<unknown>) => handlers.set(channel, fn) },
}));

vi.mock("../../../project-store", () => ({
	projectStore: {
		getProjects: () => mockProjects,
		getTasks: (projectId: string) => mockTasksByProject.get(projectId) || [],
		invalidateTasksCache: vi.fn(),
	},
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
import { wasInterruptedByAppExit } from "../interrupted-runs";
import { registerStopAllHandlers, stopAllAgents } from "../stop-all-handlers";

let root: string;
let project: Project;

function task(id: string, specId: string, withSpecDir = true): Task {
	if (withSpecDir) mkdirSync(path.join(project.path, ".workpilot", "specs", specId), { recursive: true });
	return {
		id,
		specId,
		projectId: project.id,
		title: id,
		description: "",
		status: "in_progress",
		subtasks: [],
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as unknown as Task;
}

function manager(running: string[]) {
	return {
		getRunningTasks: vi.fn(() => running),
		haltTask: vi.fn(() => true),
		isRunning: vi.fn(() => true),
	};
}

function pauseOf(specId: string) {
	return JSON.parse(
		readFileSync(path.join(project.path, ".workpilot", "specs", specId, "pause_state.json"), "utf-8"),
	);
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "wp-stop-all-"));
	project = { id: "proj-1", name: "P", path: path.join(root, "repo") } as unknown as Project;
	mockProjects.splice(0, mockProjects.length, project);
	mockTasksByProject.clear();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("stopAllAgents", () => {
	it("pauses every running task and stops the other agents", () => {
		mockTasksByProject.set(project.id, [task("t1", "001-a"), task("t2", "002-b")]);
		const agents = manager(["t1", "t2", "ideation:proj-1"]);

		const result = stopAllAgents(agents as unknown as AgentManager);

		expect(result).toEqual({ pausedTasks: ["t1", "t2"], stoppedProcesses: 1, failedTasks: [] });
		expect(agents.haltTask).toHaveBeenCalledTimes(3);
		const state = pauseOf("001-a");
		expect(state.enabled).toBe(true);
		expect(state.reason).toBe("kill_switch");
		// Unlike a pause taken when the app closed, the next launch leaves it paused.
		const paused = { ...task("t1", "001-a"), metadata: { paused: state } } as Task;
		expect(wasInterruptedByAppExit(paused, () => false)).toBe(false);
	});

	it("stops a task whose pause cannot be written all the same", () => {
		mockTasksByProject.set(project.id, [task("t1", "001-a", false)]);
		const agents = manager(["t1"]);

		const result = stopAllAgents(agents as unknown as AgentManager);

		expect(result.failedTasks).toEqual(["t1"]);
		expect(agents.haltTask).toHaveBeenCalledWith("t1");
	});

	it("does nothing when nothing runs", () => {
		const agents = manager([]);
		expect(stopAllAgents(agents as unknown as AgentManager)).toEqual({
			pausedTasks: [],
			stoppedProcesses: 0,
			failedTasks: [],
		});
		expect(agents.haltTask).not.toHaveBeenCalled();
	});

	it("leaves alone a task already paused whose process is gone", () => {
		const t1 = { ...task("t1", "001-a"), metadata: { paused: { enabled: true } } } as unknown as Task;
		mockTasksByProject.set(project.id, [t1]);
		const agents = manager(["t1"]);
		agents.isRunning.mockReturnValue(false);

		expect(stopAllAgents(agents as unknown as AgentManager).pausedTasks).toEqual([]);
		expect(agents.haltTask).not.toHaveBeenCalled();
	});

	it("still stops a task whose pause threw", () => {
		mockTasksByProject.set(project.id, [task("t1", "001-a")]);
		vi.mocked(projectStore.invalidateTasksCache).mockImplementationOnce(() => {
			throw new Error("store gone");
		});
		const agents = manager(["t1"]);

		expect(stopAllAgents(agents as unknown as AgentManager).failedTasks).toEqual(["t1"]);
		expect(agents.haltTask).toHaveBeenCalledWith("t1");
	});

	it("does not count a process that was already gone", () => {
		const agents = manager(["roadmap:proj-1"]);
		agents.haltTask.mockReturnValue(false);
		expect(stopAllAgents(agents as unknown as AgentManager).stoppedProcesses).toBe(0);
	});
});

describe("AGENTS_STOP_ALL", () => {
	it("takes no argument and answers with what it stopped", async () => {
		registerStopAllHandlers(manager([]) as unknown as AgentManager);
		const handler = handlers.get(IPC_CHANNELS.AGENTS_STOP_ALL);
		expect(await handler?.()).toEqual({
			success: true,
			data: { pausedTasks: [], stoppedProcesses: 0, failedTasks: [] },
		});
	});
});
