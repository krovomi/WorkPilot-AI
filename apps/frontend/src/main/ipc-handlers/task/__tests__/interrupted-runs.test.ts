/**
 * Closing WorkPilot while a Kanban build runs is a pause; opening it again is
 * the resume — from where the build stopped, not from the top of its phase.
 *
 * The spec directories are real (a temp dir), because what the backend reads
 * back is the file: `pause_state.json` and `.session.json`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../../../../shared/types";

const mockProjects: Project[] = [];
const mockTasksByProject: Map<string, Task[]> = new Map();

vi.mock("../../../project-store", () => ({
	projectStore: {
		getProjects: () => mockProjects,
		getTasks: (projectId: string) => mockTasksByProject.get(projectId) || [],
		invalidateTasksCache: vi.fn(),
	},
}));

vi.mock("../../../task-state-manager", () => ({
	taskStateManager: {
		getCurrentState: vi.fn(() => undefined),
		handleUiEvent: vi.fn(),
		resetForNewRun: vi.fn(),
	},
}));

vi.mock("../../../file-watcher", () => ({
	fileWatcher: { watch: vi.fn(), unwatch: vi.fn() },
}));

vi.mock("../../../worktree-paths", () => ({
	findTaskWorktree: () => null,
}));

vi.mock("../../../app-logger", () => ({
	appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	pauseRunningTasksForShutdown,
	resumeTasksInterruptedByAppExit,
	wasInterruptedByAppExit,
} from "../interrupted-runs";
import { readPersistedSessionId } from "../resume-task";

let root: string;

function specDirOf(project: Project, task: Task): string {
	return path.join(project.path, ".workpilot", "specs", task.specId);
}

function createProject(): Project {
	return {
		id: "proj-1",
		name: "Project",
		path: path.join(root, "repo"),
		createdAt: new Date().toISOString(),
		lastOpenedAt: new Date().toISOString(),
	} as unknown as Project;
}

function createTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "task-1",
		specId: "001-feature",
		projectId: "proj-1",
		title: "Feature",
		description: "Build the feature",
		status: "in_progress",
		subtasks: [],
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as Task;
}

function register(project: Project, ...tasks: Task[]): void {
	mockProjects.push(project);
	mockTasksByProject.set(project.id, tasks);
	for (const task of tasks) {
		mkdirSync(specDirOf(project, task), { recursive: true });
	}
}

function readPause(project: Project, task: Task) {
	return JSON.parse(
		readFileSync(path.join(specDirOf(project, task), "pause_state.json"), "utf-8"),
	);
}

function fakeAgentManager(running: string[] = []) {
	return {
		getRunningTasks: vi.fn(() => running),
		isRunning: vi.fn((id: string) => running.includes(id)),
		startTaskExecution: vi.fn(async () => undefined),
		startSpecCreation: vi.fn(async () => undefined),
	};
}

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "wp-interrupted-"));
	mockProjects.length = 0;
	mockTasksByProject.clear();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("closing the application", () => {
	it("records every running build as paused by the shutdown, where it stopped", () => {
		const project = createProject();
		const task = createTask({
			executionProgress: {
				phase: "coding",
				phaseProgress: 40,
				overallProgress: 44,
				currentSubtask: "subtask-2-1",
			},
			metadata: { provider: "ollama", model: "qwen3" },
		} as Partial<Task>);
		register(project, task);
		const manager = fakeAgentManager([task.id]);

		// biome-ignore lint/suspicious/noExplicitAny: structural fake
		const paused = pauseRunningTasksForShutdown(manager as any);

		expect(paused).toEqual([task.id]);
		const state = readPause(project, task);
		expect(state).toMatchObject({
			enabled: true,
			reason: "app_shutdown",
			paused_phase: "coding",
			paused_subtask_id: "subtask-2-1",
			provider: "ollama",
			model: "qwen3",
		});
	});

	it("leaves a pause the user asked for as it is", () => {
		const project = createProject();
		const task = createTask({
			metadata: {
				paused: {
					enabled: true,
					paused_at: "2026-09-27T08:00:00.000Z",
					paused_phase: "planning",
					paused_subtask_id: null,
				},
			},
		} as Partial<Task>);
		register(project, task);

		const paused = pauseRunningTasksForShutdown(
			// biome-ignore lint/suspicious/noExplicitAny: structural fake
			fakeAgentManager([task.id]) as any,
		);

		expect(paused).toEqual([]);
	});

	it("ignores a running process that is not a Kanban task", () => {
		register(createProject());
		const paused = pauseRunningTasksForShutdown(
			// biome-ignore lint/suspicious/noExplicitAny: structural fake
			fakeAgentManager(["ideation:proj-1"]) as any,
		);
		expect(paused).toEqual([]);
	});
});

describe("which tasks the last exit interrupted", () => {
	const notRunning = () => false;

	it("a shutdown pause, and a task persisted as running with no process", () => {
		const shutdown = createTask({
			status: "in_progress",
			metadata: {
				paused: {
					enabled: true,
					paused_at: null,
					paused_subtask_id: null,
					reason: "app_shutdown",
				},
			},
		} as Partial<Task>);
		expect(wasInterruptedByAppExit(shutdown, notRunning)).toBe(true);
		// A crash or a forced kill leaves no pause, only the running status.
		expect(wasInterruptedByAppExit(createTask({ status: "in_progress" }), notRunning)).toBe(true);
		expect(wasInterruptedByAppExit(createTask({ status: "ai_review" }), notRunning)).toBe(true);
	});

	it("never the user's pause, a settled task, an archived one or one already running", () => {
		const userPause = createTask({
			metadata: {
				paused: { enabled: true, paused_at: null, paused_subtask_id: null },
			},
		} as Partial<Task>);
		expect(wasInterruptedByAppExit(userPause, notRunning)).toBe(false);
		expect(wasInterruptedByAppExit(createTask({ status: "human_review" }), notRunning)).toBe(false);
		expect(wasInterruptedByAppExit(createTask({ status: "backlog" }), notRunning)).toBe(false);
		expect(
			wasInterruptedByAppExit(
				createTask({ metadata: { archivedAt: "2026-09-01" } } as Partial<Task>),
				notRunning,
			),
		).toBe(false);
		expect(wasInterruptedByAppExit(createTask(), () => true)).toBe(false);
	});
});

describe("opening the application again", () => {
	it("resumes the interrupted build with its interrupted Claude session", async () => {
		const project = createProject();
		const task = createTask({
			metadata: {
				tddMode: true,
				paused: {
					enabled: true,
					paused_at: null,
					paused_phase: "coding",
					paused_subtask_id: "subtask-2-1",
					reason: "app_shutdown",
				},
			},
		} as Partial<Task>);
		register(project, task);
		const specDir = specDirOf(project, task);
		writeFileSync(path.join(specDir, "spec.md"), "# Spec\n");
		writeFileSync(
			path.join(specDir, ".session.json"),
			JSON.stringify({ session_id: "sess-interrupted", provider: "claude" }),
		);
		writeFileSync(
			path.join(specDir, "pause_state.json"),
			JSON.stringify(task.metadata?.paused),
		);
		const manager = fakeAgentManager();

		// biome-ignore lint/suspicious/noExplicitAny: structural fake
		const resumed = await resumeTasksInterruptedByAppExit(manager as any);

		expect(resumed).toEqual([task.id]);
		expect(manager.startTaskExecution).toHaveBeenCalledTimes(1);
		const [, , specId, options] = manager.startTaskExecution.mock.calls[0] as unknown as [
			string,
			string,
			string,
			Record<string, unknown>,
		];
		expect(specId).toBe(task.specId);
		expect(options.resumeSessionId).toBe("sess-interrupted");
		expect(options.tddMode).toBe(true);
		// The flag is lifted, or the backend would pause again at its first checkpoint.
		expect(readPause(project, task).enabled).toBe(false);
	});

	it("sends a build stopped during spec creation back to the spec pipeline", async () => {
		const project = createProject();
		const task = createTask({ status: "in_progress" });
		register(project, task); // no spec.md yet
		const manager = fakeAgentManager();

		// biome-ignore lint/suspicious/noExplicitAny: structural fake
		await resumeTasksInterruptedByAppExit(manager as any);

		expect(manager.startSpecCreation).toHaveBeenCalledTimes(1);
		expect(manager.startTaskExecution).not.toHaveBeenCalled();
	});

	it("does not touch a task the user paused", async () => {
		const project = createProject();
		const task = createTask({
			metadata: {
				paused: { enabled: true, paused_at: null, paused_subtask_id: null },
			},
		} as Partial<Task>);
		register(project, task);
		const manager = fakeAgentManager();

		// biome-ignore lint/suspicious/noExplicitAny: structural fake
		const resumed = await resumeTasksInterruptedByAppExit(manager as any);

		expect(resumed).toEqual([]);
		expect(manager.startTaskExecution).not.toHaveBeenCalled();
		expect(manager.startSpecCreation).not.toHaveBeenCalled();
	});
});

describe("the session handed back to the SDK", () => {
	it("is a Claude session id, never another provider's thread", () => {
		const dir = path.join(root, "spec");
		mkdirSync(dir, { recursive: true });
		const marker = path.join(dir, ".session.json");

		writeFileSync(marker, JSON.stringify({ session_id: "sess-1", provider: "claude" }));
		expect(readPersistedSessionId(dir)).toBe("sess-1");

		writeFileSync(marker, JSON.stringify({ session_id: "thread-1", provider: "codex" }));
		expect(readPersistedSessionId(dir)).toBeUndefined();

		// Written before the provider was recorded: only Claude wrote it then.
		writeFileSync(marker, JSON.stringify({ session_id: "sess-legacy" }));
		expect(readPersistedSessionId(dir)).toBe("sess-legacy");
	});
});
