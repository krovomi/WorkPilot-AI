/**
 * The voice assistant's spoken « stop » (#385): every running task is paused
 * like the Pause button pauses it, but its process is left to end its session
 * after the tool call in flight. The spec directories are real: the backend
 * reads the file.
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
import { registerStopAfterStepHandlers, stopAgentsAfterStep } from "../stop-after-step-handlers";

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
	root = mkdtempSync(path.join(tmpdir(), "wp-stop-after-step-"));
	project = { id: "proj-1", name: "P", path: path.join(root, "repo") } as unknown as Project;
	mockProjects.splice(0, mockProjects.length, project);
	mockTasksByProject.clear();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("stopAgentsAfterStep", () => {
	it("pauses every running task without killing its process", () => {
		mockTasksByProject.set(project.id, [task("t1", "001-a"), task("t2", "002-b")]);
		const agents = manager(["t1", "t2", "ideation:proj-1"]);

		const result = stopAgentsAfterStep(agents as unknown as AgentManager);

		expect(result).toEqual({ stoppingTasks: ["t1", "t2"], failedTasks: [] });
		// The backend ends the session after the call in flight: nothing is halted here.
		expect(agents.haltTask).not.toHaveBeenCalled();
		const state = pauseOf("001-a");
		expect(state.enabled).toBe(true);
		expect(state.reason).toBe("voice_stop");
		// The next launch leaves it paused, like the kill switch.
		const paused = { ...task("t1", "001-a"), metadata: { paused: state } } as Task;
		expect(wasInterruptedByAppExit(paused, () => false)).toBe(false);
	});

	it("leaves a task already paused, and agents that are not tasks, alone", () => {
		const t1 = { ...task("t1", "001-a"), metadata: { paused: { enabled: true } } } as unknown as Task;
		mockTasksByProject.set(project.id, [t1]);
		const agents = manager(["t1", "roadmap:proj-1"]);

		expect(stopAgentsAfterStep(agents as unknown as AgentManager)).toEqual({
			stoppingTasks: [],
			failedTasks: [],
		});
		expect(agents.haltTask).not.toHaveBeenCalled();
	});

	it("reports a task whose pause cannot be written, or threw", () => {
		mockTasksByProject.set(project.id, [task("t1", "001-a", false), task("t2", "002-b")]);
		vi.mocked(projectStore.invalidateTasksCache).mockImplementationOnce(() => {
			throw new Error("store gone");
		});
		const agents = manager(["t1", "t2"]);

		expect(stopAgentsAfterStep(agents as unknown as AgentManager)).toEqual({
			stoppingTasks: [],
			failedTasks: ["t1", "t2"],
		});
		expect(agents.haltTask).not.toHaveBeenCalled();
	});
});

describe("AGENTS_STOP_AFTER_STEP", () => {
	it("takes no argument and answers with the tasks that stop", async () => {
		registerStopAfterStepHandlers(manager([]) as unknown as AgentManager);
		const handler = handlers.get(IPC_CHANNELS.AGENTS_STOP_AFTER_STEP);
		expect(await handler?.()).toEqual({
			success: true,
			data: { stoppingTasks: [], failedTasks: [] },
		});
	});
});
