/**
 * What a launch does with the builds the last exit interrupted: offered to
 * the person (default), all resumed, or left paused — and every resume from
 * where the build stopped, within the project's « En cours » limit.
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
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const sent = vi.hoisted(() => [] as Array<{ channel: string; payload: unknown }>);
const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const claudeAuth = vi.hoisted(() => ({ valid: true }));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
	},
}));

vi.mock("../../utils", () => ({
	safeSendToRenderer: (_get: unknown, channel: string, payload: unknown) =>
		sent.push({ channel, payload }),
}));

vi.mock("../../../settings-utils", () => ({ readSettingsFile: () => settings.value }));

vi.mock("../../../claude-profile-manager", () => ({
	getClaudeProfileManager: () => ({ hasValidAuth: () => claudeAuth.valid }),
}));

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

const server = vi.hoisted(() => ({
	tasks: [] as unknown[],
	ids: new Set<string>(),
	resumed: [] as string[][],
	setAside: [] as string[][],
}));

vi.mock("../interrupted-server", () => ({
	collectServerInterruptedTasks: async () => {
		for (const task of server.tasks as Array<{ taskId: string }>) server.ids.add(task.taskId);
		return server.tasks;
	},
	isServerInterruptedTask: (taskId: string) => server.ids.has(taskId),
	resumeServerInterrupted: async (taskIds: string[]) => {
		server.resumed.push(taskIds);
		for (const taskId of taskIds) server.ids.delete(taskId);
		return { resumed: [...taskIds], waiting: [], failed: [] };
	},
	setServerInterruptedAside: async (taskIds: string[]) => {
		server.setAside.push(taskIds);
	},
}));

vi.mock("../../../file-watcher", () => ({ fileWatcher: { watch: vi.fn(), unwatch: vi.fn() } }));
vi.mock("../../../worktree-paths", () => ({ findTaskWorktree: () => null }));
vi.mock("../../../app-logger", () => ({
	appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { IPC_CHANNELS } from "../../../../shared/constants";
import type { AgentManager } from "../../../agent";
import { interruptionOrigin } from "../interrupted-origin";
import {
	collectInterruptedTasks,
	offerInterruptedTasksAtLaunch,
	offerServerInterruptedTasks,
	parseResumeIds,
	registerInterruptedTaskHandlers,
	resetInterruptedPromptForTests,
	resumeInterrupted,
} from "../interrupted-prompt";

let root: string;

function specDirOf(project: Project, task: Task): string {
	return path.join(project.path, ".workpilot", "specs", task.specId);
}

function createProject(overrides: Partial<Project> = {}): Project {
	return {
		id: "proj-1",
		name: "Project",
		path: path.join(root, "repo"),
		createdAt: new Date().toISOString(),
		lastOpenedAt: new Date().toISOString(),
		...overrides,
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

function paused(reason: string | undefined, extra: Record<string, unknown> = {}) {
	return {
		metadata: {
			paused: {
				enabled: true,
				paused_at: "2026-11-28T18:00:00.000Z",
				paused_subtask_id: null,
				reason,
				...extra,
			},
		},
	} as Partial<Task>;
}

function register(project: Project, ...tasks: Task[]): void {
	mockProjects.push(project);
	mockTasksByProject.set(project.id, tasks);
	for (const task of tasks) {
		const dir = specDirOf(project, task);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "spec.md"), "# Spec\n");
		if (task.metadata?.paused) {
			writeFileSync(path.join(dir, "pause_state.json"), JSON.stringify(task.metadata.paused));
		}
	}
}

function readPause(project: Project, task: Task) {
	return JSON.parse(readFileSync(path.join(specDirOf(project, task), "pause_state.json"), "utf-8"));
}

function fakeAgentManager(running: string[] = [], needsClaude = false) {
	const listeners: Array<(...args: unknown[]) => void> = [];
	return {
		getRunningTasks: vi.fn(() => running),
		isRunning: vi.fn((id: string) => running.includes(id)),
		taskNeedsClaudeAuth: vi.fn(() => needsClaude),
		startTaskExecution: vi.fn(async () => undefined),
		startSpecCreation: vi.fn(async () => undefined),
		on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
			if (event === "exit") listeners.push(fn);
		}),
		exit: (taskId: string, projectId: string) => {
			for (const fn of listeners) fn(taskId, 0, "task-execution", projectId);
		},
	};
}

const asManager = (fake: ReturnType<typeof fakeAgentManager>) => fake as unknown as AgentManager;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "wp-interrupted-prompt-"));
	mockProjects.length = 0;
	mockTasksByProject.clear();
	handlers.clear();
	sent.length = 0;
	settings.value = {};
	claudeAuth.valid = true;
	server.tasks = [];
	server.ids.clear();
	server.resumed.length = 0;
	server.setAside.length = 0;
	resetInterruptedPromptForTests();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("which builds the last exit interrupted", () => {
	const notRunning = () => false;

	it("a close, a crash, and the person's own stop of every agent", () => {
		expect(interruptionOrigin(createTask(paused("app_shutdown")), notRunning)).toBe("app_exit");
		expect(interruptionOrigin(createTask(paused("app_shutdown", { crashed: true })), notRunning)).toBe(
			"crash",
		);
		// A crash or a forced kill leaves no pause, only the running status.
		expect(interruptionOrigin(createTask({ status: "in_progress" }), notRunning)).toBe("crash");
		expect(interruptionOrigin(createTask({ status: "ai_review" }), notRunning)).toBe("crash");
		expect(interruptionOrigin(createTask(paused("kill_switch")), notRunning)).toBe("stopped_by_you");
		expect(interruptionOrigin(createTask(paused("voice_stop")), notRunning)).toBe("stopped_by_you");
	});

	it("never the Pause button, a budget, a put-off one, a settled, archived or running task", () => {
		expect(interruptionOrigin(createTask(paused(undefined)), notRunning)).toBeNull();
		expect(interruptionOrigin(createTask(paused("budget")), notRunning)).toBeNull();
		expect(
			interruptionOrigin(createTask(paused("app_shutdown", { deferred_at: "2026-11-28" })), notRunning),
		).toBeNull();
		expect(interruptionOrigin(createTask({ status: "human_review" }), notRunning)).toBeNull();
		expect(interruptionOrigin(createTask({ status: "backlog" }), notRunning)).toBeNull();
		expect(
			interruptionOrigin(
				createTask({ metadata: { archivedAt: "2026-09-01" } } as Partial<Task>),
				notRunning,
			),
		).toBeNull();
		expect(interruptionOrigin(createTask(), () => true)).toBeNull();
	});
});

describe("the list offered at launch", () => {
	it("says where each build resumes, ticks what the app interrupted, not the person's stop", () => {
		const project = createProject();
		const coding = createTask({
			...paused("app_shutdown", { paused_phase: "coding", provider: "claude", model: "sonnet" }),
			subtasks: [
				{ id: "s1", title: "Model", description: "", status: "completed", files: [] },
				{ id: "s2", title: "Route GET /export", description: "", status: "in_progress", files: [] },
			],
		} as Partial<Task>);
		const stopped = createTask({
			id: "task-2",
			specId: "002-stopped",
			...paused("kill_switch", { paused_phase: "planning" }),
		});
		register(project, coding, stopped);

		const tasks = collectInterruptedTasks(asManager(fakeAgentManager()));

		expect(tasks).toHaveLength(2);
		const first = tasks.find((t) => t.taskId === coding.id);
		expect(first).toMatchObject({
			origin: "app_exit",
			phase: "coding",
			subtasksDone: 1,
			subtasksTotal: 2,
			nextSubtask: "Route GET /export",
			provider: "claude",
			model: "sonnet",
			blocker: null,
			selectedByDefault: true,
			projectName: "Project",
		});
		expect(tasks.find((t) => t.taskId === stopped.id)).toMatchObject({
			origin: "stopped_by_you",
			phase: "planning",
			selectedByDefault: false,
		});
	});

	it("records the pause a crashed build never got, so it reads paused, not stuck", () => {
		const project = createProject();
		const task = createTask({ status: "in_progress" });
		register(project, task);

		const [found] = collectInterruptedTasks(asManager(fakeAgentManager()));

		expect(found.origin).toBe("crash");
		expect(readPause(project, task)).toMatchObject({
			enabled: true,
			reason: "app_shutdown",
			crashed: true,
		});
	});

	it("unticks a build whose resume would fail at once, and says why", () => {
		const project = createProject();
		const task = createTask(paused("app_shutdown", { paused_phase: "planning" }));
		register(project, task);
		claudeAuth.valid = false;

		const [found] = collectInterruptedTasks(asManager(fakeAgentManager([], true)));

		expect(found.blocker).toBe("claude_auth");
		expect(found.selectedByDefault).toBe(false);
	});

	it("does not ask Claude's sign-in of a build that runs on another provider", () => {
		const project = createProject();
		register(project, createTask(paused("app_shutdown")));
		claudeAuth.valid = false;

		const [found] = collectInterruptedTasks(asManager(fakeAgentManager([], false)));

		expect(found.blocker).toBeNull();
	});
});

describe("the launch, per Settings › Agents", () => {
	it("asks by default: nothing starts before the person answers", async () => {
		const project = createProject();
		register(project, createTask(paused("app_shutdown")));
		const manager = fakeAgentManager();

		const offer = await offerInterruptedTasksAtLaunch(asManager(manager), () => null);

		expect(offer?.mode).toBe("ask");
		expect(sent).toEqual([{ channel: IPC_CHANNELS.TASK_INTERRUPTED_OFFER, payload: offer }]);
		expect(manager.startTaskExecution).not.toHaveBeenCalled();
	});

	it("resumes what the app interrupted with « Tout reprendre », never the person's stop", async () => {
		settings.value = { interruptedTasksOnLaunch: "always" };
		const project = createProject();
		const interrupted = createTask(paused("app_shutdown"));
		const stopped = createTask({ id: "task-2", specId: "002-stopped", ...paused("kill_switch") });
		register(project, interrupted, stopped);
		const manager = fakeAgentManager();

		const offer = await offerInterruptedTasksAtLaunch(asManager(manager), () => null);

		expect(offer).toMatchObject({ mode: "resumed", resumed: [interrupted.id] });
		expect(manager.startTaskExecution).toHaveBeenCalledTimes(1);
		expect(readPause(project, stopped).enabled).toBe(true);
	});

	it("starts nothing and offers nothing with « Ne rien reprendre »", async () => {
		settings.value = { interruptedTasksOnLaunch: "never" };
		register(createProject(), createTask(paused("app_shutdown")));
		const manager = fakeAgentManager();

		expect(await offerInterruptedTasksAtLaunch(asManager(manager), () => null)).toBeNull();
		expect(sent).toEqual([]);
		expect(manager.startTaskExecution).not.toHaveBeenCalled();
	});
});

describe("the person's answer", () => {
	it("resumes the ticked build with its interrupted session, and puts the others off", async () => {
		const project = createProject();
		const ticked = createTask({
			...paused("app_shutdown", { paused_phase: "coding" }),
			metadata: { ...paused("app_shutdown").metadata, tddMode: true },
		} as Partial<Task>);
		const later = createTask({ id: "task-2", specId: "002-later", ...paused("app_shutdown") });
		register(project, ticked, later);
		writeFileSync(
			path.join(specDirOf(project, ticked), ".session.json"),
			JSON.stringify({ session_id: "sess-interrupted", provider: "claude" }),
		);
		const manager = fakeAgentManager();
		registerInterruptedTaskHandlers(asManager(manager));
		await offerInterruptedTasksAtLaunch(asManager(manager), () => null);

		const resolve = handlers.get(IPC_CHANNELS.TASK_INTERRUPTED_RESOLVE);
		const result = await resolve?.({}, [ticked.id]);

		expect(result).toEqual({ resumed: [ticked.id], waiting: [], failed: [] });
		const [, , specId, options] = manager.startTaskExecution.mock.calls[0] as unknown as [
			string,
			string,
			string,
			Record<string, unknown>,
		];
		expect(specId).toBe(ticked.specId);
		expect(options.resumeSessionId).toBe("sess-interrupted");
		expect(options.tddMode).toBe(true);
		// The flag is lifted, or the backend would pause again at its first checkpoint.
		expect(readPause(project, ticked).enabled).toBe(false);
		// « Plus tard »: still paused, and not offered at the next launch.
		expect(readPause(project, later)).toMatchObject({ enabled: true });
		expect(readPause(project, later).deferred_at).toEqual(expect.any(String));
		expect(handlers.get(IPC_CHANNELS.TASK_INTERRUPTED_GET)?.()).toBeNull();
	});

	it("ignores ids the launch did not offer, and answers that are not a list of ids", async () => {
		const project = createProject();
		const other = createTask({ id: "task-9", specId: "009-other", status: "backlog" });
		register(project, createTask(paused("app_shutdown")), other);
		const manager = fakeAgentManager();
		registerInterruptedTaskHandlers(asManager(manager));
		await offerInterruptedTasksAtLaunch(asManager(manager), () => null);

		const result = await handlers.get(IPC_CHANNELS.TASK_INTERRUPTED_RESOLVE)?.({}, [other.id]);

		expect(result).toEqual({ resumed: [], waiting: [], failed: [] });
		expect(manager.startTaskExecution).not.toHaveBeenCalled();
		expect(parseResumeIds("task-1")).toBeNull();
		expect(parseResumeIds([1, 2])).toBeNull();
		expect(parseResumeIds(Array.from({ length: 500 }, (_, i) => `t${i}`))).toBeNull();
		expect(parseResumeIds(["task-1"])).toEqual(["task-1"]);
	});

	it("sends a build stopped during spec creation back to the spec pipeline", async () => {
		const project = createProject();
		const task = createTask(paused("app_shutdown"));
		register(project, task);
		rmSync(path.join(specDirOf(project, task), "spec.md"));
		const manager = fakeAgentManager();

		const [found] = collectInterruptedTasks(asManager(manager));
		await resumeInterrupted(asManager(manager), [found]);

		expect(manager.startSpecCreation).toHaveBeenCalledTimes(1);
		expect(manager.startTaskExecution).not.toHaveBeenCalled();
	});

	it("keeps « En cours » within its limit: the rest waits for a slot", async () => {
		const project = createProject({ settings: { maxParallelTasks: 1 } } as Partial<Project>);
		const first = createTask(paused("app_shutdown"));
		const second = createTask({ id: "task-2", specId: "002-second", ...paused("app_shutdown") });
		register(project, first, second);
		const running: string[] = [];
		const manager = fakeAgentManager(running);
		manager.startTaskExecution.mockImplementation(async (...args: unknown[]) => {
			const specId = args[2] as string;
			running.push(specId === first.specId ? first.id : second.id);
		});

		const items = collectInterruptedTasks(asManager(manager));
		const ordered = [items.find((t) => t.taskId === first.id), items.find((t) => t.taskId === second.id)];
		const result = await resumeInterrupted(asManager(manager), ordered as typeof items);

		expect(result).toEqual({ resumed: [first.id], waiting: [second.id], failed: [] });
		running.length = 0; // the first build ends
		manager.exit(first.id, project.id);
		await vi.waitFor(() => expect(manager.startTaskExecution).toHaveBeenCalledTimes(2));
	});
});

describe("in server mode, the runs the team server stopped", () => {
	const serverTask = (taskId: string, selectedByDefault = true) => ({
		taskId,
		projectId: "srv-1",
		projectName: "Team",
		title: taskId,
		origin: "server_restart",
		interruptedAt: null,
		phase: "coding",
		subtasksDone: 1,
		subtasksTotal: 3,
		nextSubtask: null,
		provider: null,
		model: null,
		blocker: null,
		selectedByDefault,
		onServer: true,
	});

	it("are offered with the local builds at launch", async () => {
		register(createProject(), createTask(paused("app_shutdown")));
		server.tasks = [serverTask("server:srv-1:001-a")];

		const offer = await offerInterruptedTasksAtLaunch(asManager(fakeAgentManager()), () => null);

		expect(offer?.tasks.map((t) => t.taskId)).toEqual(["task-1", "server:srv-1:001-a"]);
	});

	it("arrive once signed in, next to the unanswered ones, never twice", async () => {
		register(createProject(), createTask(paused("app_shutdown")));
		const manager = asManager(fakeAgentManager());
		await offerInterruptedTasksAtLaunch(manager, () => null);
		server.tasks = [serverTask("server:srv-1:001-a")];

		const offer = await offerServerInterruptedTasks(manager, () => null);

		expect(offer?.tasks.map((t) => t.taskId)).toEqual(["task-1", "server:srv-1:001-a"]);
		expect(await offerServerInterruptedTasks(manager, () => null)).toBeNull();
	});

	it("are resumed or set aside by the server, the local ones here", async () => {
		const project = createProject();
		const local = createTask(paused("app_shutdown"));
		register(project, local);
		server.tasks = [serverTask("server:srv-1:001-a"), serverTask("server:srv-1:002-b")];
		const manager = fakeAgentManager();
		registerInterruptedTaskHandlers(asManager(manager));
		await offerInterruptedTasksAtLaunch(asManager(manager), () => null);

		const resolve = handlers.get(IPC_CHANNELS.TASK_INTERRUPTED_RESOLVE);
		const result = await resolve?.({}, ["server:srv-1:001-a", local.id]);

		expect(result).toEqual({
			resumed: ["server:srv-1:001-a", local.id],
			waiting: [],
			failed: [],
		});
		expect(server.resumed).toEqual([["server:srv-1:001-a"]]);
		expect(server.setAside).toEqual([["server:srv-1:002-b"]]);
		expect(manager.startTaskExecution).toHaveBeenCalledTimes(1);
	});

	it("« Tout reprendre » resumes only the person's own", async () => {
		settings.value = { interruptedTasksOnLaunch: "always" };
		server.tasks = [serverTask("server:srv-1:001-a"), serverTask("server:srv-1:002-b", false)];

		const offer = await offerServerInterruptedTasks(asManager(fakeAgentManager()), () => null);

		expect(offer).toMatchObject({ mode: "resumed", resumed: ["server:srv-1:001-a"] });
		expect(server.resumed).toEqual([["server:srv-1:001-a"]]);
	});
});
