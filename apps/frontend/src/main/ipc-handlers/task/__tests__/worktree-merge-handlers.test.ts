/**
 * @vitest-environment node
 *
 * Merging a task's worktree over IPC, on a real git repository. The backend
 * (`run.py --merge`) is stood in for by a small Node script that does what
 * the real one does to git (a squash merge, staged or committed) and prints
 * the lines it prints, so the handler's reading of the result is exercised
 * end to end: progress forwarded to the window, staged changes checked in
 * the repository, the plan files rewritten, conflicts recognised.
 */

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	base: "",
	root: "",
	source: "" as string | null,
	envReady: true,
	initStatus: { ready: true, error: undefined as string | undefined },
	tasks: [] as Array<Record<string, unknown>>,
	project: {} as Record<string, unknown>,
	serverCard: null as unknown,
	fakeSpawn: null as null | (() => unknown),
	manualStatus: [] as unknown[][],
	kills: 0,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: vi.fn((...args: Parameters<typeof actual.spawn>) =>
			state.fakeSpawn ? state.fakeSpawn() : actual.spawn(...args),
		),
	};
});
vi.mock("../../../cli-tool-manager", () => ({ getToolPath: () => "git" }));
vi.mock("../../../project-store", () => ({
	projectStore: {
		getProjects: () => [state.project],
		getTasks: () => state.tasks,
	},
}));
vi.mock("../../../server-board-actions", () => ({
	findServerCard: () => state.serverCard,
}));
vi.mock("../../../server-board-review", () => ({
	mergeServerCard: vi.fn(async (_card: unknown, options: unknown) => ({
		success: true,
		data: { success: true, message: "server merge", options },
	})),
	previewServerMerge: vi.fn(() => ({ success: false, error: "server preview" })),
}));
vi.mock("../../../python-env-manager", () => ({
	getConfiguredPythonPath: () => process.execPath,
	pythonEnvManager: { getPythonEnv: () => ({ FAKE_PYTHON_ENV: "1" }) },
}));
vi.mock("../../../rate-limit-detector", () => ({
	getBestAvailableProfileEnv: () => ({ env: { CLAUDE_CONFIG_DIR: "/profiles/x" } }),
}));
vi.mock("../../../task-state-manager", () => ({
	taskStateManager: {
		handleManualStatusChange: (...args: unknown[]) => state.manualStatus.push(args),
	},
}));
vi.mock("../../../updater/path-resolver", () => ({
	getEffectiveSourcePath: () => state.source,
}));
vi.mock("../../../platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../platform")>()),
	killProcessGracefully: () => {
		state.kills += 1;
	},
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { registerWorktreeMergeHandlers } from "../worktree-merge-handlers";

type MockIpc = typeof ipcMain & {
	invokeHandler: (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
};
type Result = {
	success: boolean;
	error?: string;
	data?: Record<string, unknown> & { preview?: Record<string, unknown> };
};

const SPEC = "001-feature";
const sent: unknown[][] = [];
const mainWindow = { webContents: { send: (...args: unknown[]) => sent.push(args) } };
let windowShown: typeof mainWindow | null = mainWindow;
const pythonEnvManager = {
	isEnvReady: () => state.envReady,
	initialize: vi.fn(async () => state.initStatus),
};

registerWorktreeMergeHandlers(pythonEnvManager as never, () => windowShown as never);

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function commit(cwd: string, file: string, content: string): void {
	writeFileSync(path.join(cwd, file), content, "utf-8");
	git(cwd, "add", file);
	git(cwd, "commit", "-q", "-m", `edit ${file}`);
}

/** What the stand-in backend does on its next run. */
function scenario(s: {
	stdout?: string[];
	stderr?: string;
	git?: string[][];
	code?: number;
}): void {
	writeFileSync(
		path.join(state.base, "backend", "scenario.json"),
		JSON.stringify({ cwd: state.root, ...s }),
		"utf-8",
	);
}

function backendCall(): { argv: string[]; env: Record<string, string> } {
	return JSON.parse(
		readFileSync(path.join(state.base, "backend", "call.json"), "utf-8"),
	) as { argv: string[]; env: Record<string, string> };
}

const specDir = () => path.join(state.root, ".workpilot", "specs", SPEC);
const worktreeDir = () => path.join(state.root, ".workpilot", "worktrees", "tasks", SPEC);
const planPath = (dir: string) => path.join(dir, "implementation_plan.json");

function merge(options?: { noCommit?: boolean }): Promise<Result> {
	return (ipcMain as MockIpc).invokeHandler(
		IPC_CHANNELS.TASK_WORKTREE_MERGE,
		{},
		"task-1",
		options,
	) as Promise<Result>;
}

function preview(): Promise<Result> {
	return (ipcMain as MockIpc).invokeHandler(
		IPC_CHANNELS.TASK_WORKTREE_MERGE_PREVIEW,
		{},
		"task-1",
	) as Promise<Result>;
}

beforeEach(() => {
	state.base = mkdtempSync(path.join(tmpdir(), "wt-merge-"));
	state.root = path.join(state.base, "repo");
	mkdirSync(state.root);
	git(state.root, "init", "-q", "-b", "main");
	// Windows runners check out CRLF otherwise, and the tests compare bytes.
	git(state.root, "config", "core.autocrlf", "false");
	git(state.root, "config", "user.email", "test@example.invalid");
	git(state.root, "config", "user.name", "Test");
	git(state.root, "config", "commit.gpgsign", "false");
	commit(state.root, ".gitignore", ".workpilot/\n");
	commit(state.root, "readme.md", "hello\n");
	// The task's branch, with one commit the merge brings over.
	git(state.root, "worktree", "add", "-q", "-b", `workpilot/${SPEC}`, worktreeDir());
	commit(worktreeDir(), "feature.txt", "feature\n");
	mkdirSync(specDir(), { recursive: true });
	mkdirSync(path.join(worktreeDir(), ".workpilot", "specs", SPEC), { recursive: true });
	for (const dir of [specDir(), path.join(worktreeDir(), ".workpilot", "specs", SPEC)]) {
		writeFileSync(planPath(dir), JSON.stringify({ status: "in_progress" }), "utf-8");
	}

	const backend = path.join(state.base, "backend");
	mkdirSync(backend);
	// Runs as `node run.py ...`: Node loads an unknown extension as CommonJS.
	writeFileSync(
		path.join(backend, "run.py"),
		`const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const sc = JSON.parse(fs.readFileSync(path.join(__dirname, "scenario.json"), "utf8"));
fs.writeFileSync(path.join(__dirname, "call.json"), JSON.stringify({
	argv: process.argv.slice(2),
	env: {
		UTILITY_MODEL: process.env.UTILITY_MODEL,
		PYTHONUTF8: process.env.PYTHONUTF8,
		FAKE_PYTHON_ENV: process.env.FAKE_PYTHON_ENV,
		CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
		DEBUG: process.env.DEBUG,
	},
}));
for (const args of sc.git || []) execFileSync("git", args, { cwd: sc.cwd, stdio: "ignore" });
for (const chunk of sc.stdout || []) process.stdout.write(chunk);
if (sc.stderr) process.stderr.write(sc.stderr);
process.exitCode = sc.code || 0;
`,
		"utf-8",
	);
	state.source = backend;
	state.envReady = true;
	state.initStatus = { ready: true, error: undefined };
	state.serverCard = null;
	state.fakeSpawn = null;
	state.manualStatus = [];
	state.kills = 0;
	state.project = {
		id: "p1",
		name: "Project",
		path: state.root,
		autoBuildPath: ".workpilot",
		settings: { mainBranch: "main" },
	};
	state.tasks = [{ id: "task-1", specId: SPEC, title: "Feature", status: "human_review" }];
	sent.length = 0;
	windowShown = mainWindow;
	pythonEnvManager.initialize.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env.DEBUG;
	rmSync(state.base, { recursive: true, force: true });
});

describe("TASK_WORKTREE_MERGE", () => {
	it("hands a server card to the server", async () => {
		state.serverCard = { id: "srv" };
		const result = await merge({ noCommit: true });
		expect(result).toEqual({
			success: true,
			data: { success: true, message: "server merge", options: { noCommit: true } },
		});
	});

	it("initialises Python first, and reports why it could not", async () => {
		state.envReady = false;
		state.initStatus = { ready: false, error: "no venv" };
		expect(await merge()).toEqual({
			success: false,
			error: "Python environment not ready: no venv",
		});
		expect(pythonEnvManager.initialize).toHaveBeenCalledWith(state.source);

		state.initStatus = { ready: false, error: undefined };
		expect((await merge()).error).toBe("Python environment not ready: Unknown error");

		state.source = null;
		expect((await merge()).error).toBe(
			"Python environment not ready and WorkPilot AI source not found",
		);
	});

	it("goes on once Python initialises", async () => {
		state.envReady = false;
		// An unreadable commit message is left out, not an error.
		mkdirSync(path.join(specDir(), "suggested_commit_message.txt"));
		scenario({ git: [["merge", "--squash", `workpilot/${SPEC}`]] });
		const result = await merge({ noCommit: true });
		expect(result.data?.staged).toBe(true);
		expect(result.data?.suggestedCommitMessage).toBeUndefined();
	});

	it("refuses an unknown task, a missing backend and a missing spec", async () => {
		state.tasks = [];
		expect(await merge()).toEqual({ success: false, error: "Task not found" });

		state.tasks = [{ id: "task-1", specId: SPEC }];
		state.source = null;
		expect(await merge()).toEqual({ success: false, error: "WorkPilot AI source not found" });

		state.source = path.join(state.base, "backend");
		rmSync(specDir(), { recursive: true });
		expect(await merge()).toEqual({ success: false, error: "Spec directory not found" });
	});

	it("stages the task's changes, reads the suggested commit message and moves both plans to review", async () => {
		writeFileSync(
			path.join(specDir(), "suggested_commit_message.txt"),
			"feat: add the feature\n",
			"utf-8",
		);
		writeFileSync(
			path.join(specDir(), "task_metadata.json"),
			JSON.stringify({ baseBranch: "main" }),
			"utf-8",
		);
		scenario({
			git: [["merge", "--squash", `workpilot/${SPEC}`]],
			stdout: [
				`${JSON.stringify({ type: "progress", stage: "analyzing", percent: 10, message: "Reading" })}\n`,
				"not json at all\n",
				`${JSON.stringify({ type: "other" })}\n`,
				"Changes from the task staged",
			],
		});

		const result = await merge({ noCommit: true });

		expect(result).toEqual({
			success: true,
			data: {
				success: true,
				message: "Changes staged in main project. Review with git status and commit when ready.",
				staged: true,
				projectPath: state.root,
				suggestedCommitMessage: "feat: add the feature",
			},
		});
		expect(git(state.root, "diff", "--staged", "--name-only")).toBe("feature.txt");
		const call = backendCall();
		expect(call.argv).toEqual([
			"--spec",
			SPEC,
			"--project-dir",
			state.root,
			"--merge",
			"--no-commit",
			"--base-branch",
			"main",
		]);
		expect(call.env).toMatchObject({
			PYTHONUTF8: "1",
			FAKE_PYTHON_ENV: "1",
			CLAUDE_CONFIG_DIR: "/profiles/x",
		});
		expect(call.env.UTILITY_MODEL).toBeTruthy();
		// Only the well-formed progress line reaches the window.
		expect(sent).toEqual([
			[
				IPC_CHANNELS.TASK_MERGE_PROGRESS,
				"task-1",
				{ type: "progress", stage: "analyzing", percent: 10, message: "Reading" },
			],
		]);
		for (const dir of [specDir(), path.join(worktreeDir(), ".workpilot", "specs", SPEC)]) {
			const plan = JSON.parse(readFileSync(planPath(dir), "utf-8"));
			expect(plan).toMatchObject({
				status: "human_review",
				planStatus: "review",
				reviewReason: "completed",
				stagedInMainProject: true,
			});
			expect(plan.stagedAt).toBeTruthy();
		}
		expect(state.manualStatus[0]?.slice(0, 2)).toEqual(["task-1", "human_review"]);
	});

	it("says the changes are already staged without running the backend again", async () => {
		git(state.root, "merge", "--squash", `workpilot/${SPEC}`);
		const result = await merge({ noCommit: true });
		expect(result.data).toMatchObject({
			success: true,
			merged: false,
			staged: true,
			alreadyStaged: true,
			projectPath: state.root,
		});
		expect(String(result.data?.message)).toContain("Changes already staged (1 files)");
		expect(existsSync(path.join(state.base, "backend", "call.json"))).toBe(false);
	});

	it("keeps the card in review when the branch was already merged and committed", async () => {
		git(state.root, "merge", "-q", "--no-ff", "-m", "merge", `workpilot/${SPEC}`);
		scenario({});
		const result = await merge({ noCommit: true });
		expect(result.data).toMatchObject({
			success: true,
			staged: false,
			message:
				"Changes were already merged and committed. You can mark this task as complete when ready.",
		});
		expect(result.data?.projectPath).toBeUndefined();
	});

	it("reports that nothing was staged when the branch brings nothing", async () => {
		scenario({});
		const result = await merge({ noCommit: true });
		expect(result.data).toMatchObject({
			staged: false,
			message: "No changes to stage. The worktree may have no differences from the current branch.",
		});
	});

	it("merges in full, using the project's main branch, without a commit message", async () => {
		// The plan in the worktree is gone: nothing to update there, not an error.
		rmSync(planPath(path.join(worktreeDir(), ".workpilot", "specs", SPEC)));
		scenario({
			git: [["merge", "-q", "--no-ff", "-m", "merge", `workpilot/${SPEC}`]],
			// A last line with no newline is still read when the process exits.
			stdout: [
				`${JSON.stringify({ type: "progress", stage: "complete", percent: 100, message: "Done" })}`,
			],
		});
		const result = await merge();
		expect(result.data).toEqual({
			success: true,
			message: "Changes merged successfully. Review and mark complete when ready.",
			staged: false,
			projectPath: undefined,
			suggestedCommitMessage: undefined,
		});
		expect(backendCall().argv).not.toContain("--no-commit");
		expect(backendCall().argv.slice(-2)).toEqual(["--base-branch", "main"]);
		expect(git(state.root, "log", "-1", "--format=%s")).toBe("merge");
		expect(sent.at(-1)?.[2]).toMatchObject({ stage: "complete" });
		expect(JSON.parse(readFileSync(planPath(specDir()), "utf-8")).stagedAt).toBeUndefined();
	});

	it("survives a plan that cannot be rewritten", async () => {
		writeFileSync(planPath(specDir()), "{ not json", "utf-8");
		scenario({ stdout: ["trailing text without newline"] });
		const result = await merge();
		expect(result.data?.success).toBe(true);
		expect(readFileSync(planPath(specDir()), "utf-8")).toBe("{ not json");
	});

	it("keeps going when git cannot read its index or a plan", async () => {
		// A corrupt index: the repository is still a working tree, but status
		// and diff fail. The merge answers anyway.
		writeFileSync(path.join(state.root, ".git", "index"), "garbage", "utf-8");
		writeFileSync(
			planPath(path.join(worktreeDir(), ".workpilot", "specs", SPEC)),
			"{ broken",
			"utf-8",
		);
		scenario({ stdout: ["\n\nline\n", `${JSON.stringify({ type: "other" })}`] });
		const result = await merge({ noCommit: true });
		expect(result.data).toMatchObject({ success: true, staged: false });
		expect(JSON.parse(readFileSync(planPath(specDir()), "utf-8")).status).toBe("human_review");
	});

	it("retries a plan write that does not stick, then gives up without failing the merge", async () => {
		const fs = await import("node:fs");
		const write = vi.spyOn(fs.promises, "writeFile").mockResolvedValue(undefined);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		scenario({});
		const result = await merge();
		expect(result.data?.success).toBe(true);
		expect(write.mock.calls.length).toBeGreaterThanOrEqual(4);
		expect(error.mock.calls.some((c) => String(c[0]).includes("main plan after retries"))).toBe(true);
		expect(warn.mock.calls.some((c) => String(c[0]).includes("main plan write may not have persisted"))).toBe(true);
		write.mockRestore();
		error.mockRestore();
		warn.mockRestore();
	});

	it("recognises a conflict in the backend's output", async () => {
		state.project = { ...state.project, settings: {} };
		scenario({ stdout: ["CONFLICT (content): Merge conflict in a.txt\n"], code: 1 });
		const result = await merge();
		expect(result).toEqual({
			success: true,
			data: { success: false, message: "Merge conflicts detected", conflictFiles: [] },
		});
		expect(backendCall().argv).not.toContain("--base-branch");
	});

	it("passes on a failure without its colour codes", async () => {
		scenario({ stderr: "\u001b[31mboom: files_with_conflicts: 0\u001b[0m", code: 2 });
		const result = await merge();
		expect(result.data).toEqual({
			success: false,
			message: "Merge failed: boom: files_with_conflicts: 0",
			conflictFiles: undefined,
		});
	});

	it("reports a backend that cannot start, and tells the window", async () => {
		state.fakeSpawn = () => {
			const proc = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
			});
			queueMicrotask(() => proc.emit("error", new Error("ENOENT python")));
			return proc;
		};
		const result = await merge();
		expect(result).toEqual({ success: false, error: "Failed to run merge: ENOENT python" });
		expect(sent[0]?.[2]).toMatchObject({
			stage: "error",
			message: "Merge process crashed: ENOENT python",
		});
	});

	it("still answers when the window is gone", async () => {
		windowShown = null;
		state.fakeSpawn = () => {
			const proc = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
			});
			queueMicrotask(() => {
				proc.stdout.emit(
					"data",
					Buffer.from(`${JSON.stringify({ type: "progress", stage: "a", percent: 1, message: "m" })}\n`),
				);
				proc.stdout.emit(
					"data",
					Buffer.from(JSON.stringify({ type: "progress", stage: "b", percent: 2, message: "m" })),
				);
				proc.emit("error", new Error("gone"));
			});
			return proc;
		};
		expect((await merge()).error).toBe("Failed to run merge: gone");
		expect(sent).toEqual([]);
	});

	it("answers from the exit event when close never comes, and only once", async () => {
		state.fakeSpawn = () => {
			const proc = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
			});
			queueMicrotask(() => {
				proc.stdout.emit(
					"data",
					Buffer.from(JSON.stringify({ type: "progress", stage: "x", percent: 5, message: "m" })),
				);
				proc.emit("exit", 1, null);
				// A late spawn error after the answer changes nothing.
				setTimeout(() => proc.emit("error", new Error("late")), 150);
			});
			return proc;
		};
		const result = await merge();
		expect(result.data).toMatchObject({ success: false });
		expect(sent[0]?.[2]).toMatchObject({ stage: "x" });
		await new Promise((r) => setTimeout(r, 200));
	});

	it("stops a merge that hangs, and trusts the output it had already given", async () => {
		vi.useFakeTimers();
		let proc: (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }) | undefined;
		state.fakeSpawn = () => {
			proc = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
			});
			return proc;
		};
		const pending = merge({ noCommit: true });
		await vi.waitFor(() => expect(proc).toBeDefined());
		proc?.stdout.emit("data", Buffer.from("Successfully merged 3 files\n"));
		await vi.advanceTimersByTimeAsync(600000);
		expect(await pending).toEqual({
			success: true,
			data: {
				success: true,
				message: "Changes staged (process timed out but merge appeared successful)",
				staged: true,
				projectPath: state.root,
			},
		});
		expect(state.kills).toBe(1);
		expect(sent[0]?.[2]).toMatchObject({
			stage: "error",
			message: "Merge process timed out after 10 minutes",
		});
		// The process exiting afterwards does not answer a second time.
		proc?.emit("close", 0, null);
	});

	it("stops a merge that hangs with nothing to show for it", async () => {
		vi.useFakeTimers();
		windowShown = null;
		let started = false;
		state.fakeSpawn = () => {
			started = true;
			return Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
			});
		};
		const pending = merge();
		await vi.waitFor(() => expect(started).toBe(true));
		await vi.advanceTimersByTimeAsync(600000);
		expect(await pending).toEqual({
			success: false,
			error: "Merge process timed out. Check git status to see if merge completed.",
		});
	});

	it("answers with a failed result when the backend cannot even be spawned", async () => {
		state.fakeSpawn = () => {
			throw new Error("spawn EINVAL");
		};
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(await merge()).toEqual({ success: false, error: "spawn EINVAL" });
		expect(await preview()).toEqual({ success: false, error: "spawn EINVAL" });
		error.mockRestore();
	});

	it("logs each step when DEBUG is set", async () => {
		process.env.DEBUG = "true";
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		scenario({ git: [["merge", "--squash", `workpilot/${SPEC}`]] });
		await merge({ noCommit: true });
		expect(warn.mock.calls.some((c) => c[0] === "[MERGE DEBUG]")).toBe(true);
		warn.mockRestore();
	});

	it("unsets a wrong core.bare before merging, and skips git checks on a bare repository", async () => {
		// A source file says this is no real bare repository.
		writeFileSync(path.join(state.root, "package.json"), "{}", "utf-8");
		git(state.root, "config", "core.bare", "true");
		scenario({});
		await merge();
		expect(git(state.root, "config", "--default", "unset", "--get", "core.bare")).toBe("unset");

		// A project path that is no working tree at all: the git checks are skipped.
		const bare = path.join(state.base, "bare.git");
		git(state.base, "init", "-q", "--bare", bare);
		mkdirSync(path.join(bare, ".workpilot", "specs", SPEC), { recursive: true });
		state.project = { ...state.project, path: bare };
		scenario({});
		const result = await merge({ noCommit: true });
		expect(result.data).toMatchObject({
			success: true,
			message: "No changes to stage. The worktree may have no differences from the current branch.",
		});
	});

	it("returns a thrown error as a failed result", async () => {
		state.project = { ...state.project, path: undefined };
		const result = await merge();
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});
});

describe("TASK_WORKTREE_MERGE_PREVIEW", () => {
	it("leaves a server card to the server", async () => {
		state.serverCard = { id: "srv" };
		expect(await preview()).toEqual({ success: false, error: "server preview" });
	});

	it("initialises Python first, and reports why it could not", async () => {
		state.envReady = false;
		state.initStatus = { ready: false, error: "broken" };
		expect((await preview()).error).toBe("Python environment not ready: broken");
		state.initStatus = { ready: false, error: undefined };
		expect((await preview()).error).toBe("Python environment not ready: Unknown error");
		state.source = null;
		expect((await preview()).error).toBe(
			"Python environment not ready and WorkPilot AI source not found",
		);
	});

	it("refuses an unknown task and a missing backend", async () => {
		state.tasks = [];
		expect(await preview()).toEqual({ success: false, error: "Task not found" });
		state.tasks = [{ id: "task-1", specId: SPEC }];
		state.source = null;
		expect(await preview()).toEqual({ success: false, error: "WorkPilot AI source not found" });
	});

	it("reads the last JSON line of the backend's output and lists uncommitted files", async () => {
		state.envReady = false;
		writeFileSync(path.join(state.root, "readme.md"), "edited\n", "utf-8");
		writeFileSync(
			path.join(specDir(), "task_metadata.json"),
			JSON.stringify({ baseBranch: "release" }),
			"utf-8",
		);
		scenario({
			stdout: [
				"DEBUG: looking at files\n",
				`${JSON.stringify({
					success: true,
					files: ["feature.txt"],
					conflicts: [{ file: "a" }],
					summary: { totalFiles: 1, conflictFiles: 0, totalConflicts: 0, autoMergeable: 1, hasGitConflicts: false },
					gitConflicts: { hasConflicts: false },
				})}\n`,
			],
		});
		const result = await preview();
		expect(result).toEqual({
			success: true,
			data: {
				success: true,
				message: "Preview completed",
				preview: {
					files: ["feature.txt"],
					conflicts: [{ file: "a" }],
					summary: {
						totalFiles: 1,
						conflictFiles: 0,
						totalConflicts: 0,
						autoMergeable: 1,
						hasGitConflicts: false,
					},
					gitConflicts: { hasConflicts: false },
					uncommittedChanges: { hasChanges: true, files: ["readme.md"], count: 1 },
				},
			},
		});
		expect(backendCall().argv.slice(-3)).toEqual(["--merge-preview", "--base-branch", "release"]);
		expect(backendCall().env.DEBUG).toBe("true");
	});

	it("fills a sparse answer with empty defaults, on a clean tree, with no base branch", async () => {
		state.project = { ...state.project, settings: {} };
		scenario({ stdout: [`${JSON.stringify({ success: false, error: "no branch" })}\n`] });
		const result = await preview();
		expect(result.data).toEqual({
			success: false,
			message: "no branch",
			preview: {
				files: [],
				conflicts: [],
				summary: {
					totalFiles: 0,
					conflictFiles: 0,
					totalConflicts: 0,
					autoMergeable: 0,
					hasGitConflicts: false,
				},
				gitConflicts: null,
				uncommittedChanges: null,
			},
		});
		expect(backendCall().argv).not.toContain("--base-branch");
	});

	it("reports output with no JSON in it, and a failed run", async () => {
		scenario({ stdout: ["only logs\n"] });
		expect((await preview()).error).toBe("Failed to parse preview result: only logs\n");
		scenario({ stderr: "\u001b[1mTraceback\u001b[0m", code: 1 });
		expect((await preview()).error).toBe("Preview failed: Traceback");
	});

	it("previews even when git cannot read its index", async () => {
		writeFileSync(path.join(state.root, ".git", "index"), "garbage", "utf-8");
		scenario({ stdout: [`${JSON.stringify({ success: true })}\n`] });
		const result = await preview();
		expect(result.data?.preview?.uncommittedChanges).toBeNull();
	});

	it("skips the uncommitted check on a bare repository", async () => {
		const bare = path.join(state.base, "bare.git");
		git(state.base, "init", "-q", "--bare", bare);
		state.project = { ...state.project, path: bare };
		scenario({ stdout: [`${JSON.stringify({ success: true })}\n`] });
		expect((await preview()).data?.preview?.uncommittedChanges).toBeNull();
	});

	it("reports a backend that cannot start", async () => {
		state.fakeSpawn = () => {
			const proc = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
			});
			queueMicrotask(() => proc.emit("error", new Error("EACCES")));
			return proc;
		};
		expect(await preview()).toEqual({ success: false, error: "Failed to run preview: EACCES" });
	});

	it("returns a thrown error as a failed result", async () => {
		state.project = { ...state.project, path: undefined };
		const result = await preview();
		expect(result.success).toBe(false);
	});
});

describe("merge conflict times (#358, lot 4)", () => {
	const times = () =>
		JSON.parse(readFileSync(path.join(state.root, ".workpilot", "merge-conflict-times.json"), "utf-8")) as {
			entries: { taskId: string; detectedAt: string; resolvedAt: string | null }[];
		};

	it("records when a preview or a merge sees a conflict, and when a merge resolves it", async () => {
		// A clean preview and a merge with nothing to stage record nothing.
		scenario({ stdout: [`${JSON.stringify({ success: true, gitConflicts: { hasConflicts: false } })}\n`] });
		await preview();
		scenario({});
		await merge({ noCommit: true });
		expect(existsSync(path.join(state.root, ".workpilot", "merge-conflict-times.json"))).toBe(false);

		scenario({ stdout: [`${JSON.stringify({ success: true, gitConflicts: { hasConflicts: true } })}\n`] });
		await preview();
		scenario({ stdout: ["CONFLICT (content): Merge conflict in a.txt\n"], code: 1 });
		await merge();
		expect(times().entries).toEqual([{ taskId: SPEC, detectedAt: expect.any(String), resolvedAt: null }]);

		// A failure that is not a conflict leaves it open; the merge that goes through closes it.
		scenario({ stderr: "boom", code: 1 });
		await merge();
		expect(times().entries[0].resolvedAt).toBeNull();
		scenario({ git: [["merge", "-q", "--no-ff", "-m", "merge", `workpilot/${SPEC}`]] });
		await merge();
		const [entry] = times().entries;
		expect(Date.parse(entry.resolvedAt as string)).toBeGreaterThanOrEqual(Date.parse(entry.detectedAt));
	});

	it("closes the conflict on a staged merge, and on a branch already merged and committed", async () => {
		scenario({ stdout: ["CONFLICT (content): Merge conflict in a.txt\n"], code: 1 });
		await merge();
		scenario({ git: [["merge", "--squash", `workpilot/${SPEC}`]] });
		await merge({ noCommit: true });
		expect(times().entries[0].resolvedAt).not.toBeNull();

		git(state.root, "commit", "-q", "-m", "squashed");
		scenario({ stdout: ["CONFLICT (content): Merge conflict in a.txt\n"], code: 1 });
		await merge();
		git(state.root, "merge", "-q", "--no-ff", "-m", "merge", `workpilot/${SPEC}`);
		scenario({});
		await merge({ noCommit: true });
		expect(times().entries.map((e) => e.resolvedAt === null)).toEqual([false, false]);
	});
});
