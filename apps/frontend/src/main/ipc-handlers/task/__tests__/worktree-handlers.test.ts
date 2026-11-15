/**
 * @vitest-environment node
 *
 * The worktree handlers over IPC, on real git repositories: status and diff
 * counts read from git (discarded files left out), discard and orphan
 * cleanup through the real cleanup utility, the worktree list with its
 * orphans, staged-state reset in both plans, the impact analysis read from a
 * stand-in backend, and syncing a worktree from another branch (merge,
 * rebase, conflict undone).
 */

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
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
	project: {} as Record<string, unknown>,
	tasks: [] as Array<Record<string, unknown>>,
	serverCard: null as unknown,
	settings: {} as Record<string, unknown> | undefined,
	fakeSpawn: null as null | (() => unknown),
	manualStatus: [] as unknown[][],
	invalidated: [] as string[],
	opened: [] as unknown[][],
	openResult: { success: true } as { success: boolean; error?: string },
	detect: (async () => ({ ides: [], terminals: [] })) as () => Promise<unknown>,
	kills: 0,
	storeError: false,
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
vi.mock("../../../cli-tool-manager", () => ({ getToolPath: (name: string) => name }));
/** The store failing to read, as when projects.json is unreadable. */
const storeRead = <T,>(value: () => T): T => {
	if (state.storeError) throw new Error("store unavailable");
	return value();
};
vi.mock("../../../project-store", () => ({
	projectStore: {
		getProjects: () => storeRead(() => [state.project]),
		getProject: (id: string) =>
			storeRead(() => (id === state.project.id ? state.project : undefined)),
		getTasks: () => storeRead(() => state.tasks),
		invalidateTasksCache: (id: string) => state.invalidated.push(id),
	},
}));
vi.mock("../../../settings-utils", () => ({ readSettingsFile: () => state.settings }));
vi.mock("../../../server-board-actions", () => ({ findServerCard: () => state.serverCard }));
vi.mock("../../../server-board-review", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../server-board-review")>()),
	serverWorktreeStatus: vi.fn(async () => ({ success: true, data: { exists: true, server: true } })),
}));
vi.mock("../../../python-env-manager", () => ({
	getConfiguredPythonPath: () => process.execPath,
	pythonEnvManager: { getPythonEnv: () => ({}) },
}));
vi.mock("../../../rate-limit-detector", () => ({
	getBestAvailableProfileEnv: () => ({ env: {} }),
}));
vi.mock("../../../task-state-manager", () => ({
	taskStateManager: {
		handleManualStatusChange: (...args: unknown[]) => state.manualStatus.push(args),
	},
}));
vi.mock("../../../updater/path-resolver", () => ({
	getEffectiveSourcePath: () => state.source,
}));
vi.mock("../../../app-language", () => ({ getAppLanguage: () => "fr" }));
vi.mock("../../../platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../platform")>()),
	killProcessGracefully: () => {
		state.kills += 1;
	},
}));
vi.mock("../worktree-ide-terminal", async (importOriginal) => ({
	...(await importOriginal<typeof import("../worktree-ide-terminal")>()),
	detectInstalledTools: () => state.detect(),
	openInIDE: async (...args: unknown[]) => {
		state.opened.push(["ide", ...args]);
		return state.openResult;
	},
	openInTerminal: async (...args: unknown[]) => {
		state.opened.push(["terminal", ...args]);
		return state.openResult;
	},
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { registerWorktreeHandlers } from "../worktree-handlers";

type Result = { success: boolean; error?: string; data?: Record<string, unknown> };
const invoke = (channel: string, ...args: unknown[]): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(channel, {}, ...args);

const SPEC = "001-feature";
const pythonEnvManager = {
	isEnvReady: () => state.envReady,
	initialize: vi.fn(async () => ({ ready: false, error: "no venv" })),
};
registerWorktreeHandlers(pythonEnvManager as never, () => null);

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function commit(cwd: string, file: string, content: string, message = `edit ${file}`): void {
	writeFileSync(path.join(cwd, file), content, "utf-8");
	git(cwd, "add", file);
	git(cwd, "commit", "-q", "-m", message);
}

const worktreeDir = (spec = SPEC) =>
	path.join(state.root, ".workpilot", "worktrees", "tasks", spec);
const specDir = () => path.join(state.root, ".workpilot", "specs", SPEC);
const planFile = (dir: string) => path.join(dir, "implementation_plan.json");

function addWorktree(spec: string): string {
	git(state.root, "worktree", "add", "-q", "-b", `workpilot/${spec}`, worktreeDir(spec));
	return worktreeDir(spec);
}

function scenario(s: { stdout?: string[]; stderr?: string; code?: number }): void {
	writeFileSync(path.join(state.base, "backend", "scenario.json"), JSON.stringify(s), "utf-8");
}

beforeEach(() => {
	state.base = mkdtempSync(path.join(tmpdir(), "wt-handlers-"));
	state.root = path.join(state.base, "repo");
	mkdirSync(state.root);
	git(state.root, "init", "-q", "-b", "main");
	git(state.root, "config", "user.email", "test@example.invalid");
	git(state.root, "config", "user.name", "Test");
	git(state.root, "config", "commit.gpgsign", "false");
	commit(state.root, ".gitignore", ".workpilot/\n");
	commit(state.root, "shared.txt", "one\ntwo\n");
	mkdirSync(specDir(), { recursive: true });

	const backend = path.join(state.base, "backend");
	mkdirSync(backend);
	writeFileSync(
		path.join(backend, "run.py"),
		`const fs = require("node:fs");
const path = require("node:path");
const sc = JSON.parse(fs.readFileSync(path.join(__dirname, "scenario.json"), "utf8"));
fs.writeFileSync(path.join(__dirname, "call.json"), JSON.stringify({
	argv: process.argv.slice(2),
	env: { APP_LANGUAGE: process.env.APP_LANGUAGE, GITHUB_CLI_PATH: process.env.GITHUB_CLI_PATH },
}));
for (const chunk of sc.stdout || []) process.stdout.write(chunk);
if (sc.stderr) process.stderr.write(sc.stderr);
process.exitCode = sc.code || 0;
`,
		"utf-8",
	);
	state.source = backend;
	state.envReady = true;
	state.serverCard = null;
	state.settings = {};
	state.fakeSpawn = null;
	state.manualStatus = [];
	state.invalidated = [];
	state.opened = [];
	state.openResult = { success: true };
	state.detect = async () => ({ ides: [], terminals: [] });
	state.kills = 0;
	state.storeError = false;
	state.project = {
		id: "p1",
		name: "Project",
		path: state.root,
		autoBuildPath: ".workpilot",
		settings: { mainBranch: "main" },
	};
	state.tasks = [{ id: "task-1", specId: SPEC, title: "Feature", status: "human_review" }];
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(state.base, { recursive: true, force: true });
});

describe("TASK_WORKTREE_STATUS", () => {
	it("asks the server about a server card", async () => {
		state.serverCard = { id: "srv" };
		expect((await invoke(IPC_CHANNELS.TASK_WORKTREE_STATUS, "task-1")).data).toEqual({
			exists: true,
			server: true,
		});
	});

	it("refuses an unknown task and says when there is no worktree", async () => {
		state.tasks = [];
		expect(await invoke(IPC_CHANNELS.TASK_WORKTREE_STATUS, "task-1")).toEqual({
			success: false,
			error: "Task not found",
		});
		state.tasks = [{ id: "task-1", specId: SPEC }];
		expect(await invoke(IPC_CHANNELS.TASK_WORKTREE_STATUS, "task-1")).toEqual({
			success: true,
			data: { exists: false },
		});
	});

	it("counts the task's commits and changed lines, leaving out discarded files", async () => {
		const wt = addWorktree(SPEC);
		commit(wt, "a.txt", "1\n2\n3\n");
		commit(wt, "shared.txt", "one\n");
		commit(wt, "dropped.txt", "x\n");
		writeFileSync(
			path.join(wt, ".workpilot-discard-list"),
			"# files the user discarded\ndropped.txt\n\n",
			"utf-8",
		);
		const result = await invoke(IPC_CHANNELS.TASK_WORKTREE_STATUS, "task-1");
		expect(result).toEqual({
			success: true,
			data: {
				exists: true,
				worktreePath: path.resolve(wt),
				branch: `workpilot/${SPEC}`,
				baseBranch: "main",
				currentProjectBranch: "main",
				commitCount: 3,
				filesChanged: 2,
				additions: 3,
				deletions: 1,
			},
		});
	});

	it("reports a worktree whose git fails, and an unreadable discard list", async () => {
		const wt = addWorktree(SPEC);
		mkdirSync(path.join(wt, ".workpilot-discard-list"));
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const ok = await invoke(IPC_CHANNELS.TASK_WORKTREE_STATUS, "task-1");
		expect(ok.data).toMatchObject({ exists: true, commitCount: 0, filesChanged: 0 });
		expect(error.mock.calls.some((c) => String(c[0]).includes("discard list"))).toBe(true);

		// A worktree whose git directory is gone: status falls back to its path.
		writeFileSync(path.join(wt, ".git"), "gitdir: /nonexistent/gitdir\n", "utf-8");
		const broken = await invoke(IPC_CHANNELS.TASK_WORKTREE_STATUS, "task-1");
		expect(broken).toEqual({
			success: true,
			data: { exists: true, worktreePath: path.resolve(wt) },
		});
		error.mockRestore();
	});

	it("survives a project that is no longer a repository, and a thrown error", async () => {
		const wt = addWorktree(SPEC);
		// The worktree still answers git, the project folder does not.
		rmSync(path.join(state.root, ".git", "HEAD"));
		writeFileSync(path.join(wt, "x"), "", "utf-8");
		const result = await invoke(IPC_CHANNELS.TASK_WORKTREE_STATUS, "task-1");
		expect(result.success).toBe(true);
		expect(result.data?.currentProjectBranch).toBeUndefined();

		state.storeError = true;
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(await invoke(IPC_CHANNELS.TASK_WORKTREE_STATUS, "task-1")).toEqual({
			success: false,
			error: "store unavailable",
		});
		error.mockRestore();
	});

	it("counts nothing when the base branch does not exist", async () => {
		state.project = { ...state.project, settings: { mainBranch: "gone" } };
		addWorktree(SPEC);
		const result = await invoke(IPC_CHANNELS.TASK_WORKTREE_STATUS, "task-1");
		expect(result.data).toMatchObject({ baseBranch: "gone", commitCount: 0, filesChanged: 0 });
	});
});

describe("TASK_WORKTREE_DISCARD", () => {
	it("refuses an unknown task and has nothing to do without a worktree", async () => {
		state.tasks = [];
		expect((await invoke(IPC_CHANNELS.TASK_WORKTREE_DISCARD, "task-1")).error).toBe(
			"Task not found",
		);
		state.tasks = [{ id: "task-1", specId: SPEC }];
		expect((await invoke(IPC_CHANNELS.TASK_WORKTREE_DISCARD, "task-1")).data).toEqual({
			success: true,
			message: "No worktree to discard",
		});
	});

	it("removes the worktree and its branch, saving uncommitted work first, then moves the card back", async () => {
		const wt = addWorktree(SPEC);
		writeFileSync(path.join(wt, "wip.txt"), "unsaved\n", "utf-8");
		const result = await invoke(IPC_CHANNELS.TASK_WORKTREE_DISCARD, "task-1");
		expect(result).toEqual({
			success: true,
			data: { success: true, message: "Worktree discarded successfully" },
		});
		expect(existsSync(wt)).toBe(false);
		expect(git(state.root, "branch", "--list", `workpilot/${SPEC}`)).toBe("");
		expect(state.manualStatus.map((c) => c.slice(0, 2))).toEqual([["task-1", "backlog"]]);
	});

	it("leaves the status alone when asked to", async () => {
		addWorktree(SPEC);
		await invoke(IPC_CHANNELS.TASK_WORKTREE_DISCARD, "task-1", true);
		expect(state.manualStatus).toEqual([]);
	});

	it("refuses a worktree outside the project's worktree folder, and returns a thrown error", async () => {
		// A legacy worktree (.worktrees/) is found, but cleanup only deletes
		// inside .workpilot/worktrees/tasks.
		const legacy = path.join(state.root, ".worktrees", SPEC);
		git(state.root, "worktree", "add", "-q", "-b", `workpilot/${SPEC}`, legacy);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(await invoke(IPC_CHANNELS.TASK_WORKTREE_DISCARD, "task-1")).toEqual({
			success: false,
			error: "Failed to discard worktree: Invalid worktree path",
		});
		expect(await invoke(IPC_CHANNELS.TASK_WORKTREE_DISCARD_ORPHAN, "p1", SPEC)).toEqual({
			success: false,
			error: "Invalid worktree path",
		});
		expect(existsSync(legacy)).toBe(true);

		state.storeError = true;
		expect(await invoke(IPC_CHANNELS.TASK_WORKTREE_DISCARD, "task-1")).toEqual({
			success: false,
			error: "store unavailable",
		});
		error.mockRestore();
	});

	it("still discards when the work cannot be auto-saved, and says so in the log", async () => {
		const wt = addWorktree(SPEC);
		const hooks = path.join(state.base, "hooks");
		mkdirSync(hooks);
		writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		git(state.root, "config", "core.hooksPath", hooks);
		writeFileSync(path.join(wt, "wip.txt"), "unsaved\n", "utf-8");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const result = await invoke(IPC_CHANNELS.TASK_WORKTREE_DISCARD, "task-1");
		expect(result.data).toEqual({ success: true, message: "Worktree discarded successfully" });
		expect(
			warn.mock.calls.some((c) => c[0] === "[TASK_WORKTREE_DISCARD] Cleanup warnings:"),
		).toBe(true);
		warn.mockRestore();
	});
});

describe("TASK_WORKTREE_DISCARD_ORPHAN", () => {
	it("checks its arguments and the project", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect((await invoke(IPC_CHANNELS.TASK_WORKTREE_DISCARD_ORPHAN, "", SPEC)).error).toBe(
			"Invalid projectId",
		);
		expect((await invoke(IPC_CHANNELS.TASK_WORKTREE_DISCARD_ORPHAN, "p1", 7)).error).toBe(
			"Invalid specName",
		);
		expect((await invoke(IPC_CHANNELS.TASK_WORKTREE_DISCARD_ORPHAN, "nope", SPEC)).error).toBe(
			"Project not found",
		);
		state.project = { ...state.project, path: "" };
		expect((await invoke(IPC_CHANNELS.TASK_WORKTREE_DISCARD_ORPHAN, "p1", SPEC)).error).toBe(
			"Project path is invalid",
		);
		error.mockRestore();
	});

	it("deletes an orphan, and says whether work was saved", async () => {
		expect((await invoke(IPC_CHANNELS.TASK_WORKTREE_DISCARD_ORPHAN, "p1", SPEC)).data).toEqual({
			success: true,
			message: "No worktree to discard",
		});
		const wt = addWorktree(SPEC);
		writeFileSync(path.join(wt, "wip.txt"), "unsaved\n", "utf-8");
		expect((await invoke(IPC_CHANNELS.TASK_WORKTREE_DISCARD_ORPHAN, "p1", SPEC)).data).toEqual({
			success: true,
			message: "Orphaned worktree deleted (uncommitted changes were auto-saved)",
		});
		addWorktree("002-clean");
		expect(
			(await invoke(IPC_CHANNELS.TASK_WORKTREE_DISCARD_ORPHAN, "p1", "002-clean")).data,
		).toEqual({ success: true, message: "Orphaned worktree deleted successfully" });
	});

	it("returns a thrown error as a failed result", async () => {
		state.storeError = true;
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(await invoke(IPC_CHANNELS.TASK_WORKTREE_DISCARD_ORPHAN, "p1", SPEC)).toEqual({
			success: false,
			error: "store unavailable",
		});
		spy.mockRestore();
	});
});

describe("TASK_LIST_WORKTREES", () => {
	it("checks its arguments and the project", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect((await invoke(IPC_CHANNELS.TASK_LIST_WORKTREES, "")).error).toBe("Invalid projectId");
		expect((await invoke(IPC_CHANNELS.TASK_LIST_WORKTREES, "nope")).error).toBe(
			"Project not found",
		);
		state.project = { ...state.project, path: null };
		expect((await invoke(IPC_CHANNELS.TASK_LIST_WORKTREES, "p1")).error).toBe(
			"Project path is invalid",
		);
		error.mockRestore();
	});

	it("lists nothing when the folder does not exist", async () => {
		expect((await invoke(IPC_CHANNELS.TASK_LIST_WORKTREES, "p1")).data).toEqual({ worktrees: [] });
	});

	it("lists each worktree with its counts, flags orphans and keeps broken ones", async () => {
		const wt = addWorktree(SPEC);
		commit(wt, "a.txt", "1\n2\n");
		writeFileSync(path.join(wt, "bin.dat"), Buffer.from([0, 1, 2, 0]));
		git(wt, "add", "bin.dat");
		git(wt, "commit", "-q", "-m", "binary");
		addWorktree("002-orphan");
		// A broken worktree folder, and a stray file next to the worktrees.
		mkdirSync(worktreeDir("003-broken"));
		writeFileSync(path.join(worktreeDir("003-broken"), ".git"), "gitdir: /nonexistent\n", "utf-8");
		writeFileSync(path.join(state.root, ".workpilot", "worktrees", "tasks", "notes.txt"), "", "utf-8");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const result = await invoke(IPC_CHANNELS.TASK_LIST_WORKTREES, "p1");
		const byName = Object.fromEntries(
			((result.data?.worktrees ?? []) as Array<Record<string, unknown>>).map((w) => [w.specName, w]),
		);
		expect(Object.keys(byName).sort()).toEqual([SPEC, "002-orphan", "003-broken"]);
		expect(byName[SPEC]).toMatchObject({
			branch: `workpilot/${SPEC}`,
			baseBranch: "main",
			commitCount: 2,
			filesChanged: 2,
			additions: 2,
			deletions: 0,
			isOrphaned: false,
		});
		expect(byName["002-orphan"]).toMatchObject({ commitCount: 0, isOrphaned: true });
		expect(byName["003-broken"]).toMatchObject({ branch: "", baseBranch: "", isOrphaned: true });
		warn.mockRestore();
	});

	it("does not call anything an orphan when the task lookup came back empty", async () => {
		state.tasks = [];
		state.project = { ...state.project, settings: { mainBranch: "missing-branch" } };
		addWorktree(SPEC);
		const result = await invoke(IPC_CHANNELS.TASK_LIST_WORKTREES, "p1");
		const [item] = (result.data?.worktrees ?? []) as Array<Record<string, unknown>>;
		// The specs folder exists but no task came back: unknown, not orphaned.
		expect(item).toMatchObject({ isOrphaned: false, commitCount: 0, filesChanged: 0 });
	});

	it("returns a thrown error as a failed result", async () => {
		mkdirSync(path.join(state.root, ".workpilot", "worktrees", "tasks"), { recursive: true });
		state.tasks = null as never;
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const result = await invoke(IPC_CHANNELS.TASK_LIST_WORKTREES, "p1");
		expect(result.success).toBe(false);
		error.mockRestore();
	});
});

describe("tools, IDE and terminal", () => {
	it("passes on detected tools and a detection failure", async () => {
		state.detect = async () => ({ ides: [{ id: "vscode" }], terminals: [] });
		expect(await invoke(IPC_CHANNELS.TASK_WORKTREE_DETECT_TOOLS)).toEqual({
			success: true,
			data: { ides: [{ id: "vscode" }], terminals: [] },
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		state.detect = async () => {
			throw new Error("probe failed");
		};
		expect((await invoke(IPC_CHANNELS.TASK_WORKTREE_DETECT_TOOLS)).error).toBe("probe failed");
		state.detect = async () => {
			throw "odd";
		};
		expect((await invoke(IPC_CHANNELS.TASK_WORKTREE_DETECT_TOOLS)).error).toBe(
			"Failed to detect installed tools",
		);
		error.mockRestore();
	});

	for (const [channel, kind, setting] of [
		[IPC_CHANNELS.TASK_WORKTREE_OPEN_IN_IDE, "ide", "customIDEPath"],
		[IPC_CHANNELS.TASK_WORKTREE_OPEN_IN_TERMINAL, "terminal", "customTerminalPath"],
	] as const) {
		it(`opens only a folder of a known project in the ${kind}, with the launcher from settings`, async () => {
			const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
			expect(await invoke(channel, outside, "vscode")).toEqual({
				success: false,
				error: "Path is not a folder of a known project",
			});
			expect(state.opened).toEqual([]);
			rmSync(outside, { recursive: true });

			state.settings = { [setting]: "/opt/launcher" };
			expect(await invoke(channel, state.root, "vscode")).toEqual({
				success: true,
				data: { opened: true },
			});
			expect(state.opened).toEqual([[kind, realpathSync(state.root), "vscode", "/opt/launcher"]]);

			state.openResult = { success: false, error: "not installed" };
			expect(await invoke(channel, state.root, "vscode")).toEqual({
				success: false,
				error: "not installed",
			});

			state.settings = undefined;
			state.project = { ...state.project, path: state.root };
			const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
			state.openResult = null as never;
			expect((await invoke(channel, state.root, "vscode")).success).toBe(false);
			error.mockRestore();
		});
	}
});

describe("TASK_CLEAR_STAGED_STATE", () => {
	it("refuses an unknown task and a missing plan", async () => {
		state.tasks = [];
		expect((await invoke(IPC_CHANNELS.TASK_CLEAR_STAGED_STATE, "task-1")).error).toBe(
			"Task not found",
		);
		state.tasks = [{ id: "task-1", specId: SPEC }];
		expect((await invoke(IPC_CHANNELS.TASK_CLEAR_STAGED_STATE, "task-1")).error).toBe(
			"Implementation plan not found",
		);
	});

	it("clears the staged flags in the project plan and the worktree plan", async () => {
		const staged = { status: "human_review", stagedInMainProject: true, stagedAt: "then" };
		writeFileSync(planFile(specDir()), JSON.stringify(staged), "utf-8");
		const wt = addWorktree(SPEC);
		const wtSpec = path.join(wt, ".workpilot", "specs", SPEC);
		mkdirSync(wtSpec, { recursive: true });
		writeFileSync(planFile(wtSpec), JSON.stringify(staged), "utf-8");

		expect(await invoke(IPC_CHANNELS.TASK_CLEAR_STAGED_STATE, "task-1")).toEqual({
			success: true,
			data: { cleared: true },
		});
		for (const dir of [specDir(), wtSpec]) {
			const plan = JSON.parse(readFileSync(planFile(dir), "utf-8"));
			expect(plan.stagedInMainProject).toBeUndefined();
			expect(plan.stagedAt).toBeUndefined();
			expect(plan.status).toBe("human_review");
			expect(plan.updated_at).toBeTruthy();
		}
		expect(state.invalidated).toEqual(["p1"]);
	});

	it("tolerates a worktree without a plan or with a broken one", async () => {
		writeFileSync(planFile(specDir()), "{}", "utf-8");
		const wt = addWorktree(SPEC);
		expect((await invoke(IPC_CHANNELS.TASK_CLEAR_STAGED_STATE, "task-1")).success).toBe(true);
		const wtSpec = path.join(wt, ".workpilot", "specs", SPEC);
		mkdirSync(wtSpec, { recursive: true });
		writeFileSync(planFile(wtSpec), "{ broken", "utf-8");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect((await invoke(IPC_CHANNELS.TASK_CLEAR_STAGED_STATE, "task-1")).success).toBe(true);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("fails on a plan it cannot read or parse", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		mkdirSync(planFile(specDir()));
		expect((await invoke(IPC_CHANNELS.TASK_CLEAR_STAGED_STATE, "task-1")).success).toBe(false);
		rmSync(planFile(specDir()), { recursive: true });
		writeFileSync(planFile(specDir()), "nope", "utf-8");
		expect((await invoke(IPC_CHANNELS.TASK_CLEAR_STAGED_STATE, "task-1")).success).toBe(false);
		error.mockRestore();
	});
});

describe("TASK_WORKTREE_ANALYZE_IMPACT", () => {
	const analyze = (target?: string) =>
		invoke(IPC_CHANNELS.TASK_WORKTREE_ANALYZE_IMPACT, "task-1", target);

	it("stops when Python, the task, the backend or the branch name are not right", async () => {
		state.envReady = false;
		expect((await analyze()).error).toBe("Python environment not ready: no venv");
		state.envReady = true;
		state.tasks = [];
		expect((await analyze()).error).toBe("Task not found");
		state.tasks = [{ id: "task-1", specId: SPEC }];
		state.source = null;
		expect((await analyze()).error).toBe("WorkPilot AI source not found");
		state.source = path.join(state.base, "backend");
		expect((await analyze("bad branch; rm -rf"))).toEqual({
			success: false,
			error: "Invalid target branch name",
		});
	});

	it("reads the result from the last JSON line, past the banner", async () => {
		scenario({
			stdout: [
				"WorkPilot banner\n",
				"{ not json }\n",
				`${JSON.stringify({ success: true, body: "## Summary", rating: "4", features: "Kanban" })}\n`,
			],
		});
		expect(await analyze("develop")).toEqual({
			success: true,
			data: { success: true, body: "## Summary", rating: "4", features: "Kanban" },
		});
		const call = JSON.parse(readFileSync(path.join(state.base, "backend", "call.json"), "utf-8"));
		expect(call.argv.slice(-3)).toEqual(["--analyze-impact", "--pr-target", "develop"]);
		expect(call.env).toEqual({ APP_LANGUAGE: "fr", GITHUB_CLI_PATH: "gh" });
	});

	it("fills missing fields, and reports the backend's own error, stderr or exit code", async () => {
		scenario({ stdout: [`${JSON.stringify({ success: true, rating: 5 })}\n`] });
		expect((await analyze()).data).toEqual({
			success: true,
			body: "",
			rating: "N/A",
			features: "Non evalue",
		});
		scenario({ stdout: [`${JSON.stringify({ success: false, error: "no diff" })}\n`], code: 1 });
		expect((await analyze()).error).toBe("no diff");
		scenario({ stderr: "Traceback\n", code: 1 });
		expect((await analyze()).error).toBe("Traceback");
		scenario({ code: 3 });
		expect((await analyze()).error).toBe("Impact analysis failed (exit code 3)");
	});

	it("reports a backend that cannot start, and gives up after 60 s", async () => {
		state.fakeSpawn = () => {
			const proc = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
			});
			queueMicrotask(() => {
				proc.emit("error", new Error("ENOENT"));
				proc.emit("close", 1);
			});
			return proc;
		};
		expect((await analyze()).error).toBe("Failed to run analyze-impact: ENOENT");

		vi.useFakeTimers();
		let proc: EventEmitter | undefined;
		state.fakeSpawn = () => {
			proc = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
			});
			return proc;
		};
		const pending = analyze();
		await vi.waitFor(() => expect(proc).toBeDefined());
		await vi.advanceTimersByTimeAsync(60_000);
		expect(await pending).toEqual({ success: false, error: "Impact analysis timed out after 60s" });
		expect(state.kills).toBe(1);
		// Late events after the timeout change nothing.
		proc?.emit("close", 0);
		proc?.emit("error", new Error("late"));
	});

	it("returns a thrown error as a failed result", async () => {
		state.fakeSpawn = () => {
			throw new Error("spawn exploded");
		};
		expect(await analyze()).toEqual({ success: false, error: "spawn exploded" });
	});
});

describe("TASK_WORKTREE_SYNC_FROM_BRANCH", () => {
	const sync = (branch: unknown, strategy: "merge" | "rebase") =>
		invoke(IPC_CHANNELS.TASK_WORKTREE_SYNC_FROM_BRANCH, "task-1", branch, strategy);

	it("refuses an unknown task, a missing worktree and a bad branch name", async () => {
		state.tasks = [];
		expect((await sync("main", "merge")).error).toBe("Task not found");
		state.tasks = [{ id: "task-1", specId: SPEC }];
		expect((await sync("main", "merge")).error).toBe(
			"No worktree found for this task. The task must be running or in review.",
		);
		addWorktree(SPEC);
		expect((await sync("main;evil", "merge")).error).toBe("Invalid branch name: main;evil");
		expect((await sync("", "merge")).error).toBe("Invalid branch name: ");
	});

	it("merges or rebases the worktree onto the new commits of a branch", async () => {
		const wt = addWorktree(SPEC);
		commit(wt, "task.txt", "task\n");
		commit(state.root, "upstream.txt", "upstream\n");
		expect(await sync("main", "merge")).toEqual({
			success: true,
			data: { success: true, message: "main successfully merged into worktree" },
		});
		expect(existsSync(path.join(wt, "upstream.txt"))).toBe(true);

		commit(state.root, "more.txt", "more\n");
		expect(await sync("main", "rebase")).toEqual({
			success: true,
			data: { success: true, message: "Worktree successfully rebased onto main" },
		});
		expect(existsSync(path.join(wt, "more.txt"))).toBe(true);
	});

	for (const strategy of ["merge", "rebase"] as const) {
		it(`undoes a ${strategy} that conflicts and lists the conflicts`, async () => {
			const wt = addWorktree(SPEC);
			commit(wt, "shared.txt", "task side\n");
			commit(state.root, "shared.txt", "main side\n");
			const result = await sync("main", strategy);
			expect(result.success).toBe(false);
			expect(result.error).toBe(
				`${strategy === "rebase" ? "Rebase" : "Merge"} resulted in conflicts. Resolve them manually in the worktree.`,
			);
			expect(result.data).toMatchObject({
				success: false,
				message: "Conflicts detected with main",
				hasConflicts: true,
			});
			expect(((result.data?.conflictFiles ?? []) as string[]).some((l) => l.includes("shared.txt"))).toBe(
				true,
			);
			// Aborted: the worktree is back to the task's commit, nothing half-done.
			expect(readFileSync(path.join(wt, "shared.txt"), "utf-8")).toBe("task side\n");
			expect(git(wt, "status", "--porcelain")).toBe("");
		});
	}

	it("passes on git's own message when it fails for another reason", async () => {
		addWorktree(SPEC);
		const result = await sync("no-such-branch", "merge");
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/no-such-branch/);
	});

	it("returns a thrown error as a failed result", async () => {
		state.storeError = true;
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(await sync("main", "merge")).toEqual({ success: false, error: "store unavailable" });
		error.mockRestore();
	});
});
