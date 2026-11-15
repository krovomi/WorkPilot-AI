/**
 * Moving a card to Done by hand (TASK_UPDATE_STATUS): a PR is opened only
 * for work that is not on the base branch yet. A card merged locally ("Merge
 * to main") is closed without one; found by the Electron E2E of the Kanban
 * flow (e2e/kanban-flow.e2e.ts), where Done failed with "no commit to push".
 *
 * Real repositories, real git: the task worktree sits where the app makes
 * it (`.workpilot/worktrees/tasks/<spec>`). The PR itself is not run: with no
 * Python configured, an attempt answers "Python environment not configured",
 * which is how a test sees that the handler tried.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	task: null as Record<string, unknown> | null,
	project: null as Record<string, unknown> | null,
	getPythonPath: vi.fn((): string | null => null),
	manualChange: vi.fn(() => true),
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
			state.handlers.set(channel, fn),
		on: vi.fn(),
	},
}));
vi.mock("../shared", () => ({
	findTaskAndProject: () => ({ task: state.task, project: state.project }),
}));
vi.mock("../../../cli-tool-manager", () => ({ getToolPath: () => "git" }));
vi.mock("../../../python-env-manager", () => ({
	pythonEnvManager: { getPythonPath: state.getPythonPath },
}));
vi.mock("../../../task-state-manager", () => ({
	taskStateManager: { handleManualStatusChange: state.manualChange },
}));
vi.mock("../execution-utils", () => ({
	ensureProfileManagerInitialized: vi.fn(),
	ensureTaskEngine: vi.fn(),
	recordReviewVerdictForLearning: vi.fn(),
	requiresClaudeAuth: () => false,
}));
vi.mock("../../../app-logger", () => ({
	appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../project-store", () => ({
	projectStore: { invalidateTasksCache: vi.fn() },
}));
vi.mock("../../../file-watcher", () => ({ fileWatcher: { watch: vi.fn() } }));

import { IPC_CHANNELS } from "../../../../shared/constants";
import { registerTaskStatusHandlers } from "../execution-status-handlers";

const SPEC = "001-add-contributing";

let root: string;
let project: string;

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-c", "user.name=t", "-c", "user.email=t@e.invalid", ...args],
		{ cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
	);
}

/** The task worktree, with one commit main does not have yet. */
function taskWorktreeWithWork(): string {
	const worktree = path.join(project, ".workpilot", "worktrees", "tasks", SPEC);
	git(project, "worktree", "add", "-q", "-b", `workpilot/${SPEC}`, worktree);
	writeFileSync(path.join(worktree, "CONTRIBUTING.md"), "x\n");
	git(worktree, "add", "CONTRIBUTING.md");
	git(worktree, "commit", "-qm", "Add CONTRIBUTING.md");
	return worktree;
}

function mergeTaskBranch(): void {
	git(project, "merge", "-q", "--no-ff", "-m", "merge", `workpilot/${SPEC}`);
}

function moveToDone(options?: { skipPrCreation?: boolean }) {
	const handler = state.handlers.get(IPC_CHANNELS.TASK_UPDATE_STATUS);
	if (!handler) throw new Error("TASK_UPDATE_STATUS not registered");
	return handler({}, "t1", "done", options) as Promise<{
		success: boolean;
		error?: string;
	}>;
}

/** The status the handler settled on, as given to the state machine. */
const settledStatus = () => state.manualChange.mock.calls.at(-1)?.[1];

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "status-done-"));
	project = path.join(root, "project");
	mkdirSync(project);
	git(project, "init", "-q", "-b", "main");
	writeFileSync(path.join(project, "README.md"), "# p\n");
	writeFileSync(path.join(project, ".gitignore"), ".workpilot/\n");
	git(project, "add", ".");
	git(project, "commit", "-qm", "init");
	state.task = {
		id: "t1",
		specId: SPEC,
		title: "Add a CONTRIBUTING.md",
		status: "human_review",
		subtasks: [],
		metadata: { baseBranch: "main" },
	};
	state.project = { id: "p1", path: project, autoBuildPath: ".workpilot" };
	state.getPythonPath.mockClear();
	state.manualChange.mockClear();
	state.handlers.clear();
	registerTaskStatusHandlers({
		agentManager: { isRunning: () => false, killTask: vi.fn() },
		getMainWindow: () => null,
	} as never);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("TASK_UPDATE_STATUS to done", () => {
	it("opens a PR for work the base branch does not have", async () => {
		taskWorktreeWithWork();
		const result = await moveToDone();
		expect(state.getPythonPath).toHaveBeenCalled();
		expect(result).toEqual({
			success: false,
			error: "Python environment not configured",
		});
	});

	it("closes a card merged locally without a PR", async () => {
		taskWorktreeWithWork();
		mergeTaskBranch();
		const result = await moveToDone();
		expect(result).toEqual({ success: true });
		expect(state.getPythonPath).not.toHaveBeenCalled();
		expect(settledStatus()).toBe("done");
	});

	it("reads the base branch from the project when the card names none", async () => {
		taskWorktreeWithWork();
		mergeTaskBranch();
		state.task = { ...state.task, metadata: {} };
		state.project = { ...state.project, settings: { mainBranch: "main" } };
		expect(await moveToDone()).toEqual({ success: true });
		expect(state.getPythonPath).not.toHaveBeenCalled();
	});

	it("falls back to develop, so work merged into main alone still gets its PR", async () => {
		taskWorktreeWithWork();
		mergeTaskBranch();
		state.task = { ...state.task, metadata: undefined };
		const result = await moveToDone();
		expect(state.getPythonPath).toHaveBeenCalled();
		expect(result.success).toBe(false);
	});

	it("closes without a PR when the person asks for none", async () => {
		taskWorktreeWithWork();
		expect(await moveToDone({ skipPrCreation: true })).toEqual({ success: true });
		expect(state.getPythonPath).not.toHaveBeenCalled();
	});

	it("closes a card that has no worktree without a PR", async () => {
		expect(await moveToDone()).toEqual({ success: true });
		expect(state.getPythonPath).not.toHaveBeenCalled();
		expect(settledStatus()).toBe("done");
	});

	it("keeps a card that already has a PR at pr_created", async () => {
		taskWorktreeWithWork();
		state.task = { ...state.task, prUrl: "https://example.invalid/pr/1" };
		expect(await moveToDone()).toEqual({ success: true });
		expect(state.getPythonPath).not.toHaveBeenCalled();
		expect(settledStatus()).toBe("pr_created");
	});
});
