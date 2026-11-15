/**
 * @vitest-environment node
 *
 * Moving a task by hand, on a real project folder and a real repository:
 * done opens a PR through the completion service (its parameters on stdin,
 * the temporary script always removed, the worktree cleaned up after), human
 * review needs a real spec, AI review needs a spec and a plan and starts the
 * QA, in progress starts the right phase, and each start is checked first
 * (git, profile manager, Claude only for a task that runs on Claude, split).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_PYTHON = "fake-python-for-pr";

const state = vi.hoisted(() => ({
	found: {} as { task?: unknown; project?: unknown },
	python: "fake-python-for-pr" as string | null,
	prCall: null as null | { args: string[]; input: string; scriptExisted: boolean },
	prAnswer: (() => "") as () => string,
	handledByMachine: false,
	hasValidAuth: true,
	initError: null as unknown,
	stack: { ok: true } as { ok: boolean; error?: string },
	cleanup: vi.fn(async () => ({ success: true, warnings: [] as string[] })),
	watch: vi.fn(),
	invalidate: vi.fn(),
	recordOutcome: vi.fn(),
	logError: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const fs = await import("node:fs");
	const execFileSync = ((file: string, args: string[], opts: { input?: Buffer }) => {
		if (file !== "fake-python-for-pr") return actual.execFileSync(file, args, opts as never);
		state.prCall = {
			args,
			input: opts.input?.toString("utf-8") ?? "",
			scriptExisted: fs.existsSync(args[0]),
		};
		return state.prAnswer();
	}) as typeof actual.execFileSync;
	return { ...actual, default: { ...actual, execFileSync }, execFileSync };
});
vi.mock("../../../cli-tool-manager", () => ({
	getToolPath: () => "git",
	getToolPathAsync: async () => "git",
}));
vi.mock("../../../python-env-manager", () => ({
	pythonEnvManager: { getPythonPath: () => state.python },
}));
vi.mock("../../../utils/python-runner-env", () => ({
	pythonRunnerEnv: async (_dir: string, opts: { extra: Record<string, string> }) => ({ ...opts.extra }),
}));
vi.mock("../../../app-language", () => ({ getAppLanguage: () => "fr" }));
vi.mock("../../../file-watcher", () => ({ fileWatcher: { watch: state.watch } }));
vi.mock("../../../project-store", () => ({
	projectStore: { invalidateTasksCache: state.invalidate, getTasks: () => [] },
}));
vi.mock("../../../task-state-manager", () => ({
	taskStateManager: {
		handleManualStatusChange: () => state.handledByMachine,
		getCurrentState: () => undefined,
		clearTask: vi.fn(),
	},
}));
vi.mock("../../../utils/worktree-cleanup", () => ({ cleanupWorktree: state.cleanup }));
vi.mock("../../../settings-utils", () => ({ readSettingsFile: () => undefined }));
vi.mock("../../../learning-loop-service", () => ({
	learningLoopService: { recordTaskOutcome: state.recordOutcome },
}));
vi.mock("../../../claude-profile-manager", () => ({
	initializeClaudeProfileManager: async () => {
		if (state.initError !== null) throw state.initError;
		return { hasValidAuth: () => state.hasValidAuth };
	},
}));
vi.mock("../split-stack", () => ({
	stackSplitPartBeforeStart: async () => state.stack,
	splitStackError: (_task: unknown, error: string) => `split part blocked: ${error}`,
}));
vi.mock("../shared", () => ({ findTaskAndProject: () => state.found }));
vi.mock("../../../app-logger", () => ({
	appLog: { info: vi.fn(), warn: vi.fn(), error: state.logError },
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { Project, Task } from "../../../../shared/types";
import { registerTaskStatusHandlers } from "../execution-status-handlers";

type Result = { success: boolean; error?: string };
const update = (status: string, options?: unknown): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(IPC_CHANNELS.TASK_UPDATE_STATUS, {}, "t1", status, options);

const agent = {
	running: false,
	isRunning: vi.fn(() => agent.running),
	killTask: vi.fn(() => {
		agent.running = false;
	}),
	startQAProcess: vi.fn(async () => undefined),
	startSpecCreation: vi.fn(),
	startTaskExecution: vi.fn(),
};
const sent: unknown[][] = [];
let windowOpen = true;
registerTaskStatusHandlers({
	agentManager: agent as never,
	getMainWindow: () =>
		windowOpen ? ({ webContents: { send: (...a: unknown[]) => sent.push(a) } } as never) : null,
});

let base = "";
let projectDir = "";
let specDir = "";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function setTask(over: Partial<Task> = {}, projectOver: Partial<Project> = {}): Task {
	const task = {
		id: "t1",
		specId: "001-x",
		title: "<b>Add</b> login",
		description: "<p>Users sign in</p>",
		status: "backlog",
		subtasks: [],
		createdAt: new Date("2026-11-01T00:00:00Z"),
		metadata: { provider: "ollama" },
		...over,
	} as Task;
	state.found = { task, project: { id: "p1", path: projectDir, ...projectOver } };
	return task;
}

function writeSpec(content = "# Spec\n".padEnd(150, "x")): void {
	mkdirSync(specDir, { recursive: true });
	writeFileSync(path.join(specDir, "spec.md"), content, "utf-8");
}

function writePlan(plan: object = { status: "backlog", phases: [] }): string {
	mkdirSync(specDir, { recursive: true });
	const file = path.join(specDir, "implementation_plan.json");
	writeFileSync(file, JSON.stringify(plan), "utf-8");
	return file;
}

function addWorktree(): string {
	const wt = path.join(projectDir, ".workpilot", "worktrees", "tasks", "001-x");
	mkdirSync(wt, { recursive: true });
	return wt;
}

const planned = [{ id: "s1", status: "pending" }] as Task["subtasks"];
const silence = () => [
	vi.spyOn(console, "warn").mockImplementation(() => undefined),
	vi.spyOn(console, "error").mockImplementation(() => undefined),
];

let spies: ReturnType<typeof silence> = [];
beforeEach(() => {
	base = mkdtempSync(path.join(tmpdir(), "exec-status-"));
	projectDir = path.join(base, "project");
	mkdirSync(projectDir);
	git(projectDir, "init", "-q");
	git(projectDir, "-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
	specDir = path.join(projectDir, ".workpilot", "specs", "001-x");
	state.python = FAKE_PYTHON;
	state.prCall = null;
	state.prAnswer = () => JSON.stringify({ success: true, pr_url: "https://example.invalid/pr/1" });
	state.handledByMachine = false;
	state.hasValidAuth = true;
	state.initError = null;
	state.stack = { ok: true };
	agent.running = false;
	windowOpen = true;
	sent.length = 0;
	vi.clearAllMocks();
	spies = silence();
});
afterEach(() => {
	for (const spy of spies) spy.mockRestore();
	rmSync(base, { recursive: true, force: true });
});

describe("TASK_UPDATE_STATUS", () => {
	it("answers for an unknown task", async () => {
		expect(await update("done")).toEqual({ success: false, error: "Task not found" });
	});

	describe("done", () => {
		it("opens a PR from the worktree, with its parameters on stdin, then cleans up", async () => {
			setTask({ metadata: { provider: "ollama", baseBranch: "release" } });
			const wt = addWorktree();
			writePlan();

			expect(await update("done")).toEqual({ success: true });

			const call = state.prCall;
			expect(call?.scriptExisted).toBe(true);
			expect(call?.args).toEqual([path.join(projectDir, ".workpilot", "tmp_create_pr.py")]);
			expect(JSON.parse(call?.input ?? "")).toEqual({
				project_path: projectDir,
				spec_id: "001-x",
				task_title: "Add login",
				task_description: "Users sign in",
				base_branch: "release",
			});
			expect(existsSync(path.join(projectDir, ".workpilot", "tmp_create_pr.py"))).toBe(false);
			expect(sent).toContainEqual([
				IPC_CHANNELS.TASK_UPDATED_EVENT,
				"t1",
				{ prUrl: "https://example.invalid/pr/1" },
				"p1",
			]);
			expect(state.cleanup).toHaveBeenCalledWith(
				expect.objectContaining({ worktreePath: wt, specId: "001-x", deleteBranch: true }),
			);
			const plan = JSON.parse(readFileSync(path.join(specDir, "implementation_plan.json"), "utf-8"));
			expect(plan.status).toBe("pr_created");
		});

		it("takes the project's main branch, then develop, and tolerates cleanup trouble", async () => {
			setTask({}, { settings: { mainBranch: "trunk" } } as Partial<Project>);
			addWorktree();
			state.cleanup.mockResolvedValueOnce({ success: false, warnings: ["dirty"] });
			expect((await update("done")).success).toBe(true);
			expect(JSON.parse(state.prCall?.input ?? "").base_branch).toBe("trunk");

			setTask({ title: "", description: undefined });
			state.cleanup.mockRejectedValueOnce(new Error("locked"));
			windowOpen = false;
			expect((await update("done")).success).toBe(true);
			expect(JSON.parse(state.prCall?.input ?? "")).toMatchObject({
				base_branch: "develop",
				task_title: "",
				task_description: "",
			});
		});

		it("does not clean a worktree that is gone, nor tell a closed window", async () => {
			setTask();
			addWorktree();
			state.prAnswer = () => {
				rmSync(path.join(projectDir, ".workpilot", "worktrees"), { recursive: true });
				return JSON.stringify({ success: true });
			};
			expect((await update("done")).success).toBe(true);
			expect(state.cleanup).not.toHaveBeenCalled();
			expect(sent.some((s) => s[0] === IPC_CHANNELS.TASK_UPDATED_EVENT)).toBe(false);
		});

		it("reports the service's own failure", async () => {
			setTask();
			addWorktree();
			state.prAnswer = () => JSON.stringify({ success: false, error: "push rejected" });
			expect(await update("done")).toEqual({ success: false, error: "Failed to create PR: push rejected" });
		});

		it("reports a crash readably and removes the script all the same", async () => {
			setTask();
			addWorktree();
			state.prAnswer = () => {
				throw Object.assign(new Error("Command failed: python <huge>"), {
					stderr: "Traceback\nRuntimeError: gh not authenticated\n",
				});
			};
			expect(await update("done")).toEqual({
				success: false,
				error: "Failed to create PR: RuntimeError: gh not authenticated",
			});
			expect(existsSync(path.join(projectDir, ".workpilot", "tmp_create_pr.py"))).toBe(false);
		});

		it("needs a configured Python", async () => {
			setTask();
			addWorktree();
			state.python = null;
			expect(await update("done")).toEqual({
				success: false,
				error: "Python environment not configured",
			});
		});

		it("skips the PR when one exists, when asked, or without a worktree", async () => {
			setTask({ prUrl: "https://example.invalid/pr/9" } as Partial<Task>);
			addWorktree();
			writePlan();
			expect(await update("done")).toEqual({ success: true });
			expect(state.prCall).toBeNull();
			expect(JSON.parse(readFileSync(path.join(specDir, "implementation_plan.json"), "utf-8")).status).toBe(
				"pr_created",
			);

			setTask();
			expect(await update("done", { skipPrCreation: true })).toEqual({ success: true });
			rmSync(path.join(projectDir, ".workpilot", "worktrees"), { recursive: true });
			expect(await update("done")).toEqual({ success: true });
			expect(state.prCall).toBeNull();
			expect(JSON.parse(readFileSync(path.join(specDir, "implementation_plan.json"), "utf-8")).status).toBe(
				"done",
			);
		});

		it("records the reviewer's approval", async () => {
			setTask({ status: "human_review" });
			expect((await update("done", { skipPrCreation: true })).success).toBe(true);
			expect(state.recordOutcome).toHaveBeenCalledWith(projectDir, "001-x", "approved");
		});
	});

	describe("human review", () => {
		it("is refused without a spec of real content", async () => {
			setTask();
			const refusal = {
				success: false,
				error:
					"Cannot move to human review - no spec has been created yet. The task must complete processing before review.",
			};
			expect(await update("human_review")).toEqual(refusal);
			writeSpec("short");
			expect(await update("human_review")).toEqual(refusal);
		});

		it("treats an unreadable spec as missing", async () => {
			setTask();
			mkdirSync(path.join(specDir, "spec.md"), { recursive: true });
			expect((await update("human_review")).success).toBe(false);
		});

		it("creates a basic plan when the task has none, once a spec exists", async () => {
			setTask();
			writeSpec();
			expect(await update("human_review")).toEqual({ success: true });
			const plan = JSON.parse(readFileSync(path.join(specDir, "implementation_plan.json"), "utf-8"));
			expect(plan).toMatchObject({ feature: "<b>Add</b> login", status: "human_review", phases: [] });
			expect(state.invalidate).toHaveBeenCalledWith("p1");
		});
	});

	describe("AI review", () => {
		it("is refused without a spec or a plan", async () => {
			setTask();
			const error =
				"Cannot start AI review - the task has no spec or implementation plan yet. The task must be implemented before QA validation.";
			expect(await update("ai_review")).toEqual({ success: false, error });
			writeSpec();
			expect(await update("ai_review")).toEqual({ success: false, error });
		});

		it("starts the QA on the task's own engine and tells the renderer", async () => {
			setTask({ subtasks: planned });
			writeSpec();
			writePlan();
			expect(await update("ai_review")).toEqual({ success: true });
			expect(state.watch).toHaveBeenCalledWith("t1", specDir);
			expect(agent.startQAProcess).toHaveBeenCalledWith("t1", projectDir, "001-x", "p1");
			expect(sent).toContainEqual([IPC_CHANNELS.TASK_STATUS_CHANGE, "t1", "ai_review", "p1"]);
			const metadata = (state.found.task as Task).metadata;
			expect(metadata?.engineLocked).toBe(true);
		});

		it("stops a running build first, then starts the QA", async () => {
			setTask({ subtasks: planned });
			writeSpec();
			// The machine handles the move: no plan file is touched.
			state.handledByMachine = true;
			agent.running = true;
			expect(await update("ai_review")).toEqual({ success: true });
			expect(agent.killTask).toHaveBeenCalledWith("t1");
			expect(agent.startQAProcess).toHaveBeenCalled();
			expect(existsSync(path.join(specDir, "implementation_plan.json"))).toBe(false);
		});

		it("does not start without a repository, a profile manager or Claude auth", async () => {
			setTask({ subtasks: planned, metadata: { provider: "anthropic" } });
			writeSpec();
			writePlan();

			state.hasValidAuth = false;
			expect(await update("ai_review")).toEqual({ success: false, error: "Claude authentication required" });
			expect(sent.at(-1)?.[0]).toBe(IPC_CHANNELS.TASK_ERROR);

			state.initError = new Error("EACCES");
			const init = await update("ai_review");
			expect(init.error).toMatch(/Failed to initialize profile manager.*EACCES/);

			rmSync(path.join(projectDir, ".git"), { recursive: true });
			// Keep git from finding the temp folder's parents' repository.
			writeFileSync(path.join(projectDir, ".git"), "gitdir: /nonexistent\n");
			const noGit = await update("ai_review");
			expect(noGit.success).toBe(false);
			expect(noGit.error).toMatch(/Not a git repository/);
			expect(agent.startQAProcess).not.toHaveBeenCalled();
		});

		it("answers without a window as well", async () => {
			setTask({ subtasks: planned, metadata: { provider: "anthropic" } });
			writeSpec();
			windowOpen = false;
			state.hasValidAuth = false;
			expect((await update("ai_review")).success).toBe(false);
			state.initError = new Error("x");
			expect((await update("ai_review")).success).toBe(false);
			state.initError = null;
			state.hasValidAuth = true;
			expect((await update("ai_review")).success).toBe(true);
			rmSync(path.join(projectDir, ".git"), { recursive: true });
			writeFileSync(path.join(projectDir, ".git"), "gitdir: /nonexistent\n");
			expect((await update("ai_review")).success).toBe(false);
			expect(sent).toEqual([]);
		});
	});

	describe("in progress", () => {
		it("writes the spec first when there is none", async () => {
			setTask({ metadata: { provider: "ollama", baseBranch: "release" } });
			expect(await update("in_progress")).toEqual({ success: true });
			expect(agent.startSpecCreation).toHaveBeenCalledWith(
				"t1",
				projectDir,
				"<p>Users sign in</p>",
				specDir,
				expect.anything(),
				"release",
				"p1",
			);
			expect(sent).toContainEqual([IPC_CHANNELS.TASK_STATUS_CHANGE, "t1", "in_progress", "p1"]);
		});

		it("describes the task by its title when it has no description", async () => {
			setTask({ description: "" });
			windowOpen = false;
			await update("in_progress");
			expect(agent.startSpecCreation.mock.calls[0][2]).toBe("<b>Add</b> login");
		});

		it("plans and builds from an existing spec, with or without subtasks", async () => {
			setTask({}, { settings: { mainBranch: "trunk" } } as Partial<Project>);
			writeSpec();
			expect((await update("in_progress")).success).toBe(true);
			expect(agent.startTaskExecution).toHaveBeenLastCalledWith(
				"t1",
				projectDir,
				"001-x",
				{ parallel: false, workers: 1, baseBranch: "trunk", useWorktree: undefined, useLocalBranch: undefined },
				"p1",
			);
			setTask({ subtasks: planned, metadata: { provider: "ollama", useWorktree: true } });
			expect((await update("in_progress")).success).toBe(true);
			expect(agent.startTaskExecution).toHaveBeenCalledTimes(2);
			expect(agent.startTaskExecution.mock.calls[1][3]).toMatchObject({ useWorktree: true });
		});

		it("leaves a running build alone", async () => {
			setTask();
			agent.running = true;
			expect(await update("in_progress")).toEqual({ success: true });
			expect(agent.killTask).not.toHaveBeenCalled();
			expect(agent.startSpecCreation).not.toHaveBeenCalled();
		});

		it("does not start a split part that cannot stack on its sibling", async () => {
			setTask();
			state.stack = { ok: false, error: "conflict" };
			expect(await update("in_progress")).toEqual({ success: false, error: "split part blocked: conflict" });
			expect(sent.at(-1)).toEqual([IPC_CHANNELS.TASK_ERROR, "t1", "split part blocked: conflict"]);
			windowOpen = false;
			expect((await update("in_progress")).success).toBe(false);
		});

		it("does not start without a repository, a profile manager or Claude auth", async () => {
			setTask({ metadata: { provider: "claude" } });
			state.hasValidAuth = false;
			expect(await update("in_progress")).toEqual({ success: false, error: "Claude authentication required" });
			windowOpen = false;
			expect((await update("in_progress")).success).toBe(false);
			windowOpen = true;

			state.initError = new Error("EACCES");
			expect((await update("in_progress")).error).toMatch(/EACCES/);
			windowOpen = false;
			expect((await update("in_progress")).success).toBe(false);
			windowOpen = true;

			rmSync(path.join(projectDir, ".git"), { recursive: true });
			writeFileSync(path.join(projectDir, ".git"), "gitdir: /nonexistent\n");
			expect((await update("in_progress")).error).toMatch(/Not a git repository/);
			windowOpen = false;
			expect((await update("in_progress")).success).toBe(false);
			expect(agent.startSpecCreation).not.toHaveBeenCalled();
		});
	});

	it("stops a running build moved back to the backlog", async () => {
		setTask();
		agent.running = true;
		expect(await update("backlog")).toEqual({ success: true });
		expect(agent.killTask).toHaveBeenCalledWith("t1");
	});

	it("answers with the error when the move itself fails", async () => {
		setTask();
		// The plan path is a folder: reading it is not "missing", so creating it throws.
		mkdirSync(path.join(specDir, "implementation_plan.json"), { recursive: true });
		expect(await update("backlog")).toEqual({ success: false, error: expect.stringMatching(/EISDIR/) });
	});
});
