/**
 * @vitest-environment node
 *
 * Stacking over IPC, on real git repositories: B is put on A only when A has
 * a branch with commits, never in a loop and never once B has started. When
 * A moves, B is rebased `--onto` A's new commit; once A is merged, B goes
 * onto A's base and its PR is retargeted. A conflict is undone and listed.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	root: "",
	tasks: [] as Array<Record<string, unknown>>,
	worktrees: {} as Record<string, string>,
	specDirs: {} as Record<string, string>,
	gh: [] as string[][],
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFileSync: vi.fn((cmd: string, args: string[], opts: unknown) => {
			if (cmd === "gh-fake") {
				state.gh.push(args);
				return "";
			}
			return actual.execFileSync(cmd, args, opts as never);
		}),
	};
});
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../../app-logger", () => ({ appLog: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("../../../cli-tool-manager", () => ({
	getToolPath: (name: string) => (name === "gh" ? "gh-fake" : "git"),
}));
vi.mock("../../../server-board-actions", () => ({ findServerCard: () => null }));
vi.mock("../../../project-store", () => ({ projectStore: { getTasks: () => state.tasks } }));
vi.mock("../../../worktree-paths", () => ({
	findTaskWorktree: (_root: string, specId: string) => state.worktrees[specId] ?? null,
}));
vi.mock("../shared", () => ({
	findTaskAndProject: (id: string) => {
		const task = state.tasks.find((t) => t.id === id);
		return task ? { task, project: { id: "p", path: state.root } } : { task: null, project: null };
	},
}));
vi.mock("../resume-task", () => ({
	getSpecPaths: (task: { specId: string }) => ({ specId: task.specId }),
	allSpecDirs: (paths: { specId: string }) => [state.specDirs[paths.specId]],
}));
vi.mock("../worktree-git-refs", () => ({ getEffectiveBaseBranch: () => "main" }));
vi.mock("../execution-utils", () => ({
	atomicWriteFileSync: (file: string, content: string) => writeFileSync(file, content, "utf-8"),
}));

import { stackOn, stackStatus, stackUpdate } from "../stack-handlers";

const { execFileSync } = await vi.importActual<typeof import("node:child_process")>(
	"node:child_process",
);

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function commit(cwd: string, file: string, content: string): string {
	writeFileSync(path.join(cwd, file), content, "utf-8");
	git(cwd, "add", file);
	git(cwd, "commit", "-q", "-m", `edit ${file}`);
	return git(cwd, "rev-parse", "HEAD");
}

function metadataOf(specId: string): Record<string, unknown> {
	return JSON.parse(
		readFileSync(path.join(state.specDirs[specId], "task_metadata.json"), "utf-8"),
	) as Record<string, unknown>;
}

function setMetadata(specId: string, patch: Record<string, unknown>): void {
	const task = state.tasks.find((t) => t.specId === specId);
	if (task) task.metadata = { ...(task.metadata as object), ...patch };
}

/** Starts B the way `create_worktree` does once B is stacked: from A's branch. */
function startChild(): string {
	const wt = path.join(state.root, "..", "wt-b");
	git(state.root, "worktree", "add", "-q", "-b", "workpilot/002-b", wt, "workpilot/001-a");
	state.worktrees["002-b"] = wt;
	commit(wt, "b.txt", "b\n");
	return wt;
}

beforeEach(() => {
	const base = mkdtempSync(path.join(tmpdir(), "stack-"));
	state.root = path.join(base, "repo");
	mkdirSync(state.root);
	git(state.root, "init", "-q", "-b", "main");
	git(state.root, "config", "user.email", "test@example.invalid");
	git(state.root, "config", "user.name", "Test");
	git(state.root, "config", "commit.gpgsign", "false");
	commit(state.root, "readme.md", "hello\n");
	state.specDirs = {};
	for (const spec of ["001-a", "002-b"]) {
		state.specDirs[spec] = path.join(base, "specs", spec);
		mkdirSync(state.specDirs[spec], { recursive: true });
	}
	state.tasks = [
		{ id: "task-a", specId: "001-a", title: "A", status: "human_review", metadata: {} },
		{
			id: "task-b",
			specId: "002-b",
			title: "B",
			status: "backlog",
			metadata: { blockedBy: ["task-a"] },
		},
	];
	state.worktrees = {};
	state.gh = [];
});

function startParent(): string {
	const wt = path.join(state.root, "..", "wt-a");
	git(state.root, "worktree", "add", "-q", "-b", "workpilot/001-a", wt, "main");
	state.worktrees["001-a"] = wt;
	return wt;
}

describe("stack handlers", () => {
	it("refuses a parent without a worktree, then one without commits", async () => {
		expect(await stackOn("task-b", "task-a")).toEqual({
			success: false,
			error: "parent_no_worktree",
		});
		startParent();
		expect(await stackOn("task-b", "task-a")).toEqual({
			success: false,
			error: "parent_no_commits",
		});
	});

	it("refuses a loop, an unknown id and a child that already started", async () => {
		state.tasks[0].metadata = { blockedBy: ["task-b"] };
		expect(await stackOn("task-b", "task-a")).toEqual({ success: false, error: "cycle" });
		expect(await stackOn("../x", "task-a")).toEqual({ success: false, error: "task_not_found" });
		state.tasks[0].metadata = {};
		state.worktrees["002-b"] = state.root;
		expect(await stackOn("task-b", "task-a")).toEqual({ success: false, error: "child_started" });
	});

	it("writes the stack fields with A's commit", async () => {
		const a = startParent();
		const sha = commit(a, "a.txt", "a\n");
		const result = await stackOn("task-b", "task-a");
		expect(result.success).toBe(true);
		expect(metadataOf("002-b")).toEqual({
			baseBranch: "workpilot/001-a",
			useLocalBranch: true,
			stackParent: "001-a",
			stackParentSha: sha,
			stackTrunk: "main",
		});
	});

	it("rebases B onto A's new commit, and lists the files of a conflict", async () => {
		const a = startParent();
		const first = commit(a, "a.txt", "a\n");
		const stacked = await stackOn("task-b", "task-a");
		setMetadata("002-b", stacked.data ?? {});
		const b = startChild();
		expect(stackStatus("task-b").data).toMatchObject({ stacked: true, moved: false });

		const second = commit(a, "a2.txt", "a2\n");
		expect(stackStatus("task-b").data).toMatchObject({ moved: true, currentSha: second });
		const updated = await stackUpdate("task-b");
		expect(updated).toMatchObject({ success: true, data: { outcome: "rebased" } });
		git(b, "merge-base", "--is-ancestor", second, "HEAD");
		expect(metadataOf("002-b").stackParentSha).toBe(second);
		expect(first).not.toBe(second);

		// A and B now touch the same line: the rebase is undone, the file listed.
		setMetadata("002-b", { stackParentSha: second });
		commit(b, "a.txt", "from b\n");
		commit(a, "a.txt", "from a\n");
		const conflicted = await stackUpdate("task-b");
		expect(conflicted).toMatchObject({
			success: false,
			error: "conflict",
			data: { conflicts: ["a.txt"] },
		});
		expect(git(b, "status", "--porcelain")).toBe("");
	});

	it("refuses a dirty worktree and a running task", async () => {
		const a = startParent();
		commit(a, "a.txt", "a\n");
		setMetadata("002-b", (await stackOn("task-b", "task-a")).data ?? {});
		const b = startChild();
		commit(a, "a2.txt", "a2\n");
		writeFileSync(path.join(b, "b.txt"), "dirty\n", "utf-8");
		expect(await stackUpdate("task-b")).toEqual({ success: false, error: "dirty" });
		state.tasks[1].status = "in_progress";
		expect(await stackUpdate("task-b")).toEqual({ success: false, error: "running" });
	});

	it("moves B onto A's base once A is merged and retargets its PR", async () => {
		const a = startParent();
		commit(a, "a.txt", "a\n");
		setMetadata("002-b", (await stackOn("task-b", "task-a")).data ?? {});
		const b = startChild();
		// A lands on main (as a squash would), then A is done.
		const merged = commit(state.root, "a.txt", "a\n");
		state.tasks[0].status = "done";
		setMetadata("002-b", { prUrl: "https://github.com/o/r/pull/7" });

		const result = await stackUpdate("task-b");
		expect(result).toMatchObject({ success: true, data: { outcome: "moved_to_base" } });
		git(b, "merge-base", "--is-ancestor", merged, "HEAD");
		expect(git(b, "log", "--format=%s", `${merged}..HEAD`)).toBe("edit b.txt");
		expect(metadataOf("002-b")).toEqual({ baseBranch: "main" });
		expect(state.gh).toEqual([["pr", "edit", "https://github.com/o/r/pull/7", "--base", "main"]]);
	});
});
