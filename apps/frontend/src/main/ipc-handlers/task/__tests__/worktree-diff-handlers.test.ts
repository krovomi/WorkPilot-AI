/**
 * @vitest-environment node
 *
 * The worktree's diff and one file's diff over IPC, on a real git
 * repository: committed, uncommitted and untracked changes against the
 * task's base branch, WorkPilot's own files and build output left out,
 * discarded files hidden, the Agent Trace attribution applied, and a file
 * path from the renderer refused when it climbs out of the worktree.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	root: "",
	project: {} as Record<string, unknown>,
	tasks: [] as Array<Record<string, unknown>>,
	serverCard: null as unknown,
	storeError: false,
}));

vi.mock("../../../cli-tool-manager", () => ({ getToolPath: () => "git" }));
vi.mock("../../../project-store", () => ({
	projectStore: {
		getProjects: () => {
			if (state.storeError) throw new Error("store unavailable");
			return [state.project];
		},
		getTasks: () => state.tasks,
	},
}));
vi.mock("../../../server-board-actions", () => ({ findServerCard: () => state.serverCard }));
vi.mock("../../../server-board-review", () => ({
	serverWorktreeDiff: vi.fn(async () => ({ success: true, data: { files: [], summary: "server" } })),
	serverFileDiff: vi.fn(async (_card: unknown, file: string) => ({
		success: true,
		data: { path: file, status: "modified", additions: 0, deletions: 0 },
	})),
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { isWorkpilotArtifact, registerWorktreeDiffHandlers } from "../worktree-diff-handlers";

type Result = { success: boolean; error?: string; data?: Record<string, unknown> };
const invoke = (channel: string, ...args: unknown[]): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(channel, {}, ...args);

registerWorktreeDiffHandlers();

const SPEC = "001-feature";
const worktreeDir = () => path.join(state.root, ".workpilot", "worktrees", "tasks", SPEC);

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function write(cwd: string, file: string, content: string): void {
	mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
	writeFileSync(path.join(cwd, file), content, "utf-8");
}

function commit(cwd: string, file: string, content: string): void {
	write(cwd, file, content);
	git(cwd, "add", file);
	git(cwd, "commit", "-q", "-m", `edit ${file}`);
}

let base = "";
beforeEach(() => {
	base = mkdtempSync(path.join(tmpdir(), "wt-diff-"));
	state.root = path.join(base, "repo");
	mkdirSync(state.root);
	git(state.root, "init", "-q", "-b", "main");
	// Windows runners check out CRLF otherwise, and the tests compare bytes.
	git(state.root, "config", "core.autocrlf", "false");
	git(state.root, "config", "user.email", "test@example.invalid");
	git(state.root, "config", "user.name", "Test");
	git(state.root, "config", "commit.gpgsign", "false");
	commit(state.root, ".gitignore", ".workpilot/worktrees/\n");
	commit(state.root, "keep.txt", "a\nb\nc\n");
	commit(state.root, "gone.txt", "bye\n");
	git(state.root, "worktree", "add", "-q", "-b", `workpilot/${SPEC}`, worktreeDir());
	state.project = {
		id: "p1",
		path: state.root,
		autoBuildPath: ".workpilot",
		settings: { mainBranch: "main" },
	};
	state.tasks = [{ id: "task-1", specId: SPEC }];
	state.serverCard = null;
	state.storeError = false;
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("isWorkpilotArtifact", () => {
	it("names WorkPilot's own folder and files, on either separator", () => {
		expect(isWorkpilotArtifact(".workpilot")).toBe(true);
		expect(isWorkpilotArtifact(".workpilot\\specs\\x.json")).toBe(true);
		expect(isWorkpilotArtifact(".workpilot-discard-list")).toBe(true);
		expect(isWorkpilotArtifact("src/.workpilot")).toBe(false);
	});
});

describe("TASK_WORKTREE_DIFF", () => {
	it("asks the server about a server card", async () => {
		state.serverCard = { id: "srv" };
		expect((await invoke(IPC_CHANNELS.TASK_WORKTREE_DIFF, "task-1")).data).toEqual({
			files: [],
			summary: "server",
		});
	});

	it("refuses an unknown task and a task without a worktree", async () => {
		state.tasks = [];
		expect((await invoke(IPC_CHANNELS.TASK_WORKTREE_DIFF, "task-1")).error).toBe("Task not found");
		state.tasks = [{ id: "task-1", specId: "002-other" }];
		expect((await invoke(IPC_CHANNELS.TASK_WORKTREE_DIFF, "task-1")).error).toBe(
			"No worktree found for this task",
		);
	});

	it("lists committed, uncommitted and untracked changes, without WorkPilot files, build output or discarded files", async () => {
		const wt = worktreeDir();
		commit(wt, "keep.txt", "a\nB\nc\nd\n");
		git(wt, "rm", "-q", "gone.txt");
		git(wt, "commit", "-q", "-m", "remove");
		write(wt, "new.txt", "one\ntwo\n");
		write(wt, "bin/Debug/app.dll", "binary-ish\n");
		write(wt, ".workpilot/specs/001-feature/plan.json", "{}");
		write(wt, "hidden.txt", "discarded\n");
		write(wt, ".workpilot-discard-list", "# discarded by the user\nhidden.txt\n");
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const result = await invoke(IPC_CHANNELS.TASK_WORKTREE_DIFF, "task-1");

		const files = (result.data?.files ?? []) as Array<Record<string, unknown>>;
		expect(files.map((f) => [f.path, f.status]).sort()).toEqual([
			["gone.txt", "deleted"],
			["keep.txt", "modified"],
			["new.txt", "added"],
		]);
		expect(result.data?.summary).toMatch(/^3 files changed, \d+ insertions\(\+\), \d+ deletions\(-\)$/);
		expect(result.data?.attribution).toBeUndefined();
		expect(errors.mock.calls.some((c) => String(c[0]).includes("Loaded 1 discarded"))).toBe(true);
		errors.mockRestore();
	});

	it("tells which lines an agent wrote when the build recorded a trace", async () => {
		const wt = worktreeDir();
		commit(wt, "keep.txt", "a\nb\nc\nd\n");
		write(
			wt,
			`.workpilot/specs/${SPEC}/agent-trace-summary.json`,
			JSON.stringify({
				files: { "keep.txt": { added: 1, ai: 1, human: 0, unknown: 0 } },
				totals: { added: 1, ai: 1, human: 0, unknown: 0 },
				models: { "model-x": 1 },
			}),
		);
		const result = await invoke(IPC_CHANNELS.TASK_WORKTREE_DIFF, "task-1");
		const [file] = (result.data?.files ?? []) as Array<Record<string, unknown>>;
		expect(file.attribution).toEqual({ added: 1, ai: 1, human: 0, unknown: 0 });
		expect(result.data?.attribution).toEqual({
			added: 1,
			ai: 1,
			human: 0,
			unknown: 0,
			models: { "model-x": 1 },
		});
	});

	it("falls back to the project's copy of the trace", async () => {
		commit(worktreeDir(), "keep.txt", "a\nb\nc\nd\n");
		write(
			state.root,
			`.workpilot/specs/${SPEC}/agent-trace-summary.json`,
			JSON.stringify({
				files: {},
				totals: { added: 1, ai: 1, human: 0, unknown: 0 },
				models: {},
			}),
		);
		const result = await invoke(IPC_CHANNELS.TASK_WORKTREE_DIFF, "task-1");
		expect(result.data?.attribution).toMatchObject({ ai: 1 });
	});

	it("logs an unreadable discard list and still answers", async () => {
		mkdirSync(path.join(worktreeDir(), ".workpilot-discard-list"));
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const result = await invoke(IPC_CHANNELS.TASK_WORKTREE_DIFF, "task-1");
		expect(result.success).toBe(true);
		expect(errors.mock.calls.some((c) => String(c[0]).includes("Error reading discard list"))).toBe(
			true,
		);
		errors.mockRestore();
	});

	it("reports git failing as an error, never as an empty list", async () => {
		// Windows refuses to overwrite the hidden .git file: replace it.
		rmSync(path.join(worktreeDir(), ".git"), { force: true });
		writeFileSync(path.join(worktreeDir(), ".git"), "gitdir: /nonexistent\n", "utf-8");
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const result = await invoke(IPC_CHANNELS.TASK_WORKTREE_DIFF, "task-1");
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
		state.storeError = true;
		expect(await invoke(IPC_CHANNELS.TASK_WORKTREE_DIFF, "task-1")).toEqual({
			success: false,
			error: "store unavailable",
		});
		errors.mockRestore();
	});
});

describe("TASK_FILE_DIFF", () => {
	const fileDiff = (file: unknown) => invoke(IPC_CHANNELS.TASK_FILE_DIFF, "task-1", file);

	it("asks the server about a server card", async () => {
		state.serverCard = { id: "srv" };
		expect((await fileDiff("a.txt")).data).toMatchObject({ path: "a.txt" });
	});

	it("refuses an unknown task, a missing worktree and a path out of the worktree", async () => {
		state.tasks = [];
		expect((await fileDiff("a.txt")).error).toBe("Task not found");
		state.tasks = [{ id: "task-1", specId: "002-other" }];
		expect((await fileDiff("a.txt")).error).toBe("No worktree found for this task");
		state.tasks = [{ id: "task-1", specId: SPEC }];
		for (const bad of ["../secret.txt", "src\\..\\..\\x", "", "./"]) {
			expect(await fileDiff(bad)).toEqual({ success: false, error: "Invalid file path" });
		}
	});

	it("gives the committed diff of a file, with its counts and status", async () => {
		const wt = worktreeDir();
		commit(wt, "keep.txt", "a\nB\nc\n");
		commit(wt, "added.txt", "x\ny\n");
		git(wt, "rm", "-q", "gone.txt");
		git(wt, "commit", "-q", "-m", "rm");
		git(wt, "mv", "keep.txt", "moved.txt");
		git(wt, "commit", "-q", "-m", "mv");

		const modified = await fileDiff("./added.txt");
		expect(modified.data).toMatchObject({ path: "added.txt", status: "added", additions: 2, deletions: 0 });
		expect(String(modified.data?.patch)).toContain("+x");
		expect((await fileDiff("gone.txt")).data).toMatchObject({ status: "deleted", deletions: 1 });
		expect((await fileDiff("moved.txt")).data).toMatchObject({ status: "added" });
	});

	it("falls back to uncommitted changes, then to the working tree against the index", async () => {
		const wt = worktreeDir();
		write(wt, "keep.txt", "a\nb\nc\nd\n");
		const unstaged = await fileDiff("keep.txt");
		expect(unstaged.data).toMatchObject({ status: "modified", additions: 1, deletions: 0 });
		git(wt, "add", "keep.txt");
		write(wt, "keep.txt", "a\n");
		expect((await fileDiff("keep.txt")).data).toMatchObject({ status: "modified" });
	});

	it("builds an added patch for an untracked file", async () => {
		write(worktreeDir(), "notes/todo.md", "first\nsecond");
		const result = await fileDiff("notes\\todo.md");
		expect(result.data).toEqual({
			path: "notes/todo.md",
			status: "added",
			additions: 2,
			deletions: 0,
			patch:
				"diff --git a/notes/todo.md b/notes/todo.md\n--- /dev/null\n+++ b/notes/todo.md\n@@ -0,0 +1,2 @@\n+first\n+second",
		});
	});

	it("counts a binary file as no lines, and reads an untracked folder as an empty addition", async () => {
		const wt = worktreeDir();
		writeFileSync(path.join(wt, "image.bin"), Buffer.from([0, 255, 0, 1]));
		git(wt, "add", "image.bin");
		git(wt, "commit", "-q", "-m", "binary");
		expect((await fileDiff("image.bin")).data).toMatchObject({
			status: "added",
			additions: 0,
			deletions: 0,
		});
		write(wt, "fresh/inner.txt", "x\n");
		expect((await fileDiff("fresh")).data).toMatchObject({ status: "added", additions: 1 });
	});

	it("answers 'no diff' for an unchanged file, and on a branch git cannot name", async () => {
		expect((await fileDiff("keep.txt")).data).toEqual({
			path: "keep.txt",
			status: "modified",
			additions: 0,
			deletions: 0,
			patch: undefined,
		});
		// Windows refuses to overwrite the hidden .git file: replace it.
		rmSync(path.join(worktreeDir(), ".git"), { force: true });
		writeFileSync(path.join(worktreeDir(), ".git"), "gitdir: /nonexistent\n", "utf-8");
		expect((await fileDiff("keep.txt")).data).toMatchObject({ patch: undefined });
	});

	it("returns a thrown error as a failed result", async () => {
		state.storeError = true;
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(await fileDiff("keep.txt")).toEqual({ success: false, error: "store unavailable" });
		errors.mockRestore();
	});
});
