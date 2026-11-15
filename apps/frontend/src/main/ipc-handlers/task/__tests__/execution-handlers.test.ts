/**
 * @vitest-environment node
 *
 * Starting, stopping, pausing and resuming a task, on a real project and
 * repository: a start is refused (and the board told why) without a window,
 * a repository, a split base or Claude when the task needs it; it then
 * writes the spec, plans or builds, on the task's own engine. A server card
 * starts and stops on the server. A Claude session is resumed only from a
 * Claude marker. Pause writes pause_state.json in every spec copy, during
 * any phase; stop clears it and tells the machine whether a plan exists.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	projects: [] as Array<Record<string, unknown>>,
	tasks: [] as unknown[],
	serverCard: null as unknown,
	serverStart: { success: true } as { success: boolean; error?: string },
	serverStop: { success: true } as { success: boolean; error?: string },
	stack: { ok: true } as { ok: boolean; error?: string },
	xstate: undefined as string | undefined,
	hasValidAuth: true,
	uiEvent: vi.fn(),
	resetForNewRun: vi.fn(),
	resume: vi.fn(async (): Promise<unknown> => ({ success: true })),
	updatePlan: vi.fn(async (): Promise<unknown> => ({ phases: [] })),
	watch: vi.fn(),
	unwatch: vi.fn(),
	invalidate: vi.fn(),
	registered: [] as string[],
}));

vi.mock("../../../cli-tool-manager", () => ({ getToolPath: () => "git", getToolPathAsync: async () => "git" }));
vi.mock("../../../project-store", () => ({
	projectStore: {
		getProjects: () => state.projects,
		getTasks: () => state.tasks,
		invalidateTasksCache: state.invalidate,
	},
}));
vi.mock("../../../server-board-actions", () => ({
	findServerCard: () => state.serverCard,
	startServerCard: async () => state.serverStart,
	stopServerCard: async () => state.serverStop,
}));
vi.mock("../../../task-state-manager", () => ({
	taskStateManager: {
		handleUiEvent: state.uiEvent,
		resetForNewRun: state.resetForNewRun,
		getCurrentState: () => state.xstate,
		clearTask: vi.fn(),
	},
}));
vi.mock("../../../file-watcher", () => ({ fileWatcher: { watch: state.watch, unwatch: state.unwatch } }));
vi.mock("../../../settings-utils", () => ({ readSettingsFile: () => undefined }));
vi.mock("../../../learning-loop-service", () => ({ learningLoopService: { recordTaskOutcome: vi.fn() } }));
vi.mock("../../../claude-profile-manager", () => ({
	initializeClaudeProfileManager: async () => ({ hasValidAuth: () => state.hasValidAuth }),
}));
vi.mock("../split-stack", () => ({
	stackSplitPartBeforeStart: async () => state.stack,
	splitStackError: (_t: unknown, e: string) => `split: ${e}`,
}));
vi.mock("../resume-task", async (importOriginal) => ({
	...(await importOriginal<typeof import("../resume-task")>()),
	resumePausedTask: state.resume,
}));
vi.mock("../plan-file-utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("../plan-file-utils")>()),
	updatePlanSubtasks: state.updatePlan,
}));
for (const [file, name] of [
	["../execution-review-handlers", "registerTaskReviewHandlers"],
	["../execution-status-handlers", "registerTaskStatusHandlers"],
	["../execution-resume-handlers", "registerTaskResumeHandlers"],
	["../execution-recovery-handlers", "registerTaskRecoveryHandlers"],
	["../subtask-unblock-handlers", "registerSubtaskUnblockHandlers"],
] as const) {
	vi.doMock(file, () => ({ [name]: () => state.registered.push(name) }));
}
vi.mock("../../../app-logger", () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { Task } from "../../../../shared/types";

type Result = { success: boolean; error?: string; data?: unknown };
const invoke = (channel: string, ...args: unknown[]): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(channel, {}, ...args);

const agent = {
	running: false,
	isRunning: vi.fn(() => agent.running),
	haltTask: vi.fn(() => agent.running),
	startSpecCreation: vi.fn(),
	startTaskExecution: vi.fn(),
};
const sent: unknown[][] = [];
let windowOpen = true;

const { getTaskControl, registerTaskExecutionHandlers } = await import("../execution-handlers");
expect(getTaskControl()).toBeNull();
registerTaskExecutionHandlers(agent as never, () =>
	windowOpen ? ({ webContents: { send: (...a: unknown[]) => sent.push(a) } } as never) : null,
);
// biome-ignore lint/style/noNonNullAssertion: registered just above
const control = getTaskControl()!;

let base = "";
let projectDir = "";
let specDir = "";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function setTask(over: Partial<Task> = {}, settings?: unknown): Task {
	const task = {
		id: "t1",
		specId: "001-x",
		title: "Add login",
		description: "Users sign in",
		status: "backlog",
		subtasks: [],
		metadata: { provider: "ollama" },
		...over,
	} as Task;
	state.tasks = [task];
	state.projects = [{ id: "p1", path: projectDir, settings }];
	return task;
}
const write = (file: string, data: unknown) =>
	writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data), "utf-8");
const read = (file: string) => JSON.parse(readFileSync(file, "utf-8"));

beforeEach(() => {
	base = mkdtempSync(path.join(tmpdir(), "exec-handlers-"));
	projectDir = path.join(base, "project");
	mkdirSync(projectDir);
	git(projectDir, "init", "-q");
	git(projectDir, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
	specDir = path.join(projectDir, ".workpilot", "specs", "001-x");
	mkdirSync(specDir, { recursive: true });
	state.projects = [];
	state.tasks = [];
	state.serverCard = null;
	state.serverStart = { success: true };
	state.serverStop = { success: true };
	state.stack = { ok: true };
	state.xstate = undefined;
	state.hasValidAuth = true;
	agent.running = false;
	windowOpen = true;
	sent.length = 0;
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(base, { recursive: true, force: true });
});

describe("registration", () => {
	it("registers every group of task handlers once", () => {
		expect(state.registered).toEqual([
			"registerTaskReviewHandlers",
			"registerTaskStatusHandlers",
			"registerTaskResumeHandlers",
			"registerTaskRecoveryHandlers",
			"registerSubtaskUnblockHandlers",
		]);
	});

	it("tells whether a task runs", async () => {
		agent.running = true;
		expect(await invoke(IPC_CHANNELS.TASK_CHECK_RUNNING, "t1")).toEqual({ success: true, data: true });
		expect(control.isRunning("t1")).toBe(true);
	});
});

describe("start", () => {
	it("needs the window", async () => {
		windowOpen = false;
		expect(await control.start("t1")).toBe(false);
	});

	it("starts a server card on the server, and reports a refusal", async () => {
		state.serverCard = { cardId: "c" };
		expect(await control.start("t1")).toBe(true);
		state.serverStart = { success: false, error: "quota" };
		expect(await control.start("t1")).toBe(false);
		expect(sent).toEqual([[IPC_CHANNELS.TASK_ERROR, "t1", "quota"]]);
		expect(agent.startSpecCreation).not.toHaveBeenCalled();
	});

	it("tells the board why a task cannot start", async () => {
		expect(await control.start("t1")).toBe(false);
		expect(sent.at(-1)).toEqual([IPC_CHANNELS.TASK_ERROR, "t1", "Task or project not found"]);

		setTask({ metadata: { provider: "anthropic" } });
		state.hasValidAuth = false;
		expect(await control.start("t1")).toBe(false);
		expect(String(sent.at(-1)?.[2])).toMatch(/^Claude authentication required/);

		setTask();
		state.stack = { ok: false, error: "conflict" };
		expect(await control.start("t1")).toBe(false);
		expect(sent.at(-1)).toEqual([IPC_CHANNELS.TASK_ERROR, "t1", "split: conflict"]);
		expect(state.uiEvent).not.toHaveBeenCalled();
	});

	it("writes the spec of a new task, on its own engine", async () => {
		const task = setTask({ metadata: { provider: "ollama", baseBranch: "release" } });
		expect(await control.start("t1")).toBe(true);
		expect(state.uiEvent).toHaveBeenCalledWith("t1", { type: "PLANNING_STARTED" }, task, expect.anything());
		expect(state.resetForNewRun).toHaveBeenCalledWith("t1");
		expect(state.watch).toHaveBeenCalledWith("t1", specDir);
		expect(agent.startSpecCreation).toHaveBeenCalledWith(
			"t1",
			projectDir,
			"Users sign in",
			specDir,
			expect.objectContaining({ provider: "ollama" }),
			"release",
			"p1",
		);
		expect(task.metadata?.engineLocked).toBe(true);
	});

	it("plans from an existing spec, then builds a planned task, with its options", async () => {
		setTask({ description: "", metadata: { provider: "ollama", tddMode: true } as Task["metadata"] }, { mainBranch: "trunk" });
		write(path.join(specDir, "spec.md"), "# Spec");
		expect(await control.start("t1", { enableStreaming: false, streamingSessionId: "s9" })).toBe(true);
		expect(agent.startTaskExecution).toHaveBeenLastCalledWith(
			"t1",
			projectDir,
			"001-x",
			expect.objectContaining({ baseBranch: "trunk", tddMode: true, enableStreaming: false, streamingSessionId: "s9" }),
			"p1",
		);

		setTask({ subtasks: [{ id: "a" }] as Task["subtasks"] });
		state.xstate = "done";
		expect(await control.start("t1")).toBe(true);
		// A done task starts over from the backlog: the machine gets the reset copy.
		expect(state.uiEvent.mock.calls.at(-1)?.[2]).toMatchObject({ status: "backlog" });
		expect(agent.startTaskExecution.mock.calls.at(-1)?.[3]).toMatchObject({ enableStreaming: true, streamingSessionId: "t1" });
	});

	it("also starts through the IPC event", async () => {
		setTask();
		(ipcMain as unknown as { emit: (c: string, ...a: unknown[]) => void }).emit(IPC_CHANNELS.TASK_START, {}, "t1");
		await vi.waitFor(() => expect(agent.startSpecCreation).toHaveBeenCalled());
	});
});

describe("TASK_RESUME_SESSION", () => {
	const resume = () => invoke(IPC_CHANNELS.TASK_RESUME_SESSION, "t1");
	const session = (data: unknown) => write(path.join(specDir, ".session.json"), data);

	it("resumes the build with the saved Claude session", async () => {
		expect(await resume()).toEqual({ success: false, error: "Task not found" });
		setTask({ metadata: { baseBranch: "release", useWorktree: true } as Task["metadata"] });
		expect((await resume()).error).toMatch(/^No persisted SDK session found/);
		session({ session_id: "sess-1" });
		expect(await resume()).toEqual({ success: true });
		expect(agent.startTaskExecution).toHaveBeenCalledWith(
			"t1",
			projectDir,
			"001-x",
			expect.objectContaining({ resumeSessionId: "sess-1", baseBranch: "release", useWorktree: true }),
			"p1",
		);
		session({ session_id: "sess-2", provider: "anthropic" });
		expect(await resume()).toEqual({ success: true });
		setTask({ metadata: undefined }, { mainBranch: "trunk" });
		session({ session_id: "sess-3", provider: "claude" });
		expect(await resume()).toEqual({ success: true });
		expect(agent.startTaskExecution.mock.calls.at(-1)?.[3]).toMatchObject({ baseBranch: "trunk" });
	});

	it("never hands another provider's thread to the Claude SDK", async () => {
		setTask();
		session({ session_id: "thread-1", provider: "codex" });
		expect(await resume()).toEqual({
			success: false,
			error: "The saved session belongs to codex: only a Claude session can be resumed.",
		});
		expect(agent.startTaskExecution).not.toHaveBeenCalled();
	});

	it("explains a broken or incomplete session file", async () => {
		setTask();
		session("{ broken");
		expect((await resume()).error).toMatch(/^Could not read \.session\.json: /);
		session({});
		expect(await resume()).toEqual({ success: false, error: ".session.json is missing the session_id field." });
	});
});

describe("stop", () => {
	const stop = () => (ipcMain as unknown as { emit: (c: string, ...a: unknown[]) => void }).emit(IPC_CHANNELS.TASK_STOP, {}, "t1");

	it("stops a server card on the server, and reports a refusal", async () => {
		state.serverCard = { cardId: "c" };
		control.stop("t1");
		state.serverStop = { success: false, error: "gone" };
		control.stop("t1");
		await vi.waitFor(() => expect(sent).toEqual([[IPC_CHANNELS.TASK_ERROR, "t1", "gone"]]));
		windowOpen = false;
		control.stop("t1");
		await new Promise((r) => setTimeout(r, 10));
		expect(sent).toHaveLength(1);
		expect(agent.haltTask).not.toHaveBeenCalled();
	});

	it("halts the build, lifts the pause and tells the machine whether a plan exists", () => {
		const task = setTask();
		write(path.join(specDir, "pause_state.json"), { enabled: true, paused_phase: "coding" });
		write(path.join(specDir, "implementation_plan.json"), { phases: [{ subtasks: [{ status: "pending" }] }] });
		stop();
		expect(agent.haltTask).toHaveBeenCalledWith("t1");
		expect(state.unwatch).toHaveBeenCalledWith("t1");
		expect(read(path.join(specDir, "pause_state.json"))).toMatchObject({ enabled: false, paused_phase: "coding" });
		expect(state.uiEvent).toHaveBeenCalledWith("t1", { type: "USER_STOPPED", hasPlan: true }, task, expect.anything());

		write(path.join(specDir, "implementation_plan.json"), "{ broken");
		control.stop("t1");
		expect(state.uiEvent).toHaveBeenLastCalledWith("t1", { type: "USER_STOPPED", hasPlan: false }, task, expect.anything());
		rmSync(path.join(specDir, "implementation_plan.json"));
		control.stop("t1");
		expect(state.uiEvent.mock.calls.at(-1)?.[1]).toEqual({ type: "USER_STOPPED", hasPlan: false });
	});

	it("only halts a task it does not know, and survives a pause it cannot clear", () => {
		control.stop("t1");
		expect(agent.haltTask).toHaveBeenCalled();
		expect(state.uiEvent).not.toHaveBeenCalled();

		setTask();
		mkdirSync(path.join(specDir, "pause_state.json"));
		expect(() => control.stop("t1")).not.toThrow();
		expect(state.uiEvent).toHaveBeenCalled();
	});
});

describe("TASK_UPDATE_PLAN", () => {
	it("writes the edited plan, or says it could not", async () => {
		expect(await invoke(IPC_CHANNELS.TASK_UPDATE_PLAN, "t1", [])).toEqual({ success: false, error: "Task not found" });
		setTask();
		expect(await invoke(IPC_CHANNELS.TASK_UPDATE_PLAN, "t1", [{ name: "P" }])).toEqual({ success: true });
		expect(state.updatePlan).toHaveBeenCalledWith(path.join(specDir, "implementation_plan.json"), [{ name: "P" }], "p1");
		state.updatePlan.mockResolvedValueOnce(null);
		expect((await invoke(IPC_CHANNELS.TASK_UPDATE_PLAN, "t1", [])).error).toMatch(/^Failed to update plan/);
	});
});

describe("TASK_PAUSE and TASK_RESUME", () => {
	const pause = (subtask?: string) => invoke(IPC_CHANNELS.TASK_PAUSE, "t1", subtask);

	it("pauses a task during any phase, in every spec copy, and halts its process", async () => {
		expect(await pause()).toEqual({ success: false, error: "Task not found" });
		setTask({
			executionProgress: { phase: "coding", currentSubtask: "s2" },
			metadata: { provider: "ollama", model: "qwen3" },
		} as Partial<Task>);
		const wtSpec = path.join(projectDir, ".workpilot", "worktrees", "tasks", "001-x", ".workpilot", "specs", "001-x");
		mkdirSync(wtSpec, { recursive: true });
		agent.running = true;

		const result = await pause();
		expect(result).toMatchObject({ success: true, data: { taskId: "t1", paused: true, specDirs: 2 } });
		for (const dir of [specDir, wtSpec]) {
			expect(read(path.join(dir, "pause_state.json"))).toMatchObject({
				enabled: true,
				paused_subtask_id: "s2",
				provider: "ollama",
				model: "qwen3",
			});
		}
		expect(agent.haltTask).toHaveBeenCalledWith("t1");
		expect(state.invalidate).toHaveBeenCalledWith("p1");

		agent.running = false;
		setTask({ metadata: undefined });
		expect((await pause("s9")).success).toBe(true);
		expect(read(path.join(specDir, "pause_state.json"))).toMatchObject({ paused_subtask_id: "s9", provider: null });
		setTask({ metadata: undefined });
		await pause();
		expect(read(path.join(specDir, "pause_state.json")).paused_subtask_id).toBeNull();
	});

	it("needs a spec folder it can write to", async () => {
		setTask();
		rmSync(path.join(projectDir, ".workpilot"), { recursive: true });
		expect(await pause()).toEqual({ success: false, error: "Spec directory not found" });
		mkdirSync(path.join(specDir, "pause_state.json"), { recursive: true });
		expect(await pause()).toEqual({ success: false, error: "Could not write pause state" });
	});

	it("answers an error rather than throwing", async () => {
		setTask();
		agent.haltTask.mockImplementationOnce(() => {
			throw new Error("boom");
		});
		expect(await pause()).toEqual({ success: false, error: "Error: boom" });
	});

	it("resumes through the shared resume path", async () => {
		expect(await invoke(IPC_CHANNELS.TASK_RESUME, "t1")).toEqual({ success: true });
		expect(state.resume).toHaveBeenCalledWith(agent, "t1");
		state.resume.mockRejectedValueOnce(new Error("nope"));
		expect(await invoke(IPC_CHANNELS.TASK_RESUME, "t1")).toEqual({ success: false, error: "Error: nope" });
	});
});
