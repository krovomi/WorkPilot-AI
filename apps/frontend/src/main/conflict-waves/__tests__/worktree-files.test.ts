/**
 * The files a task's worktree really changed, read from a real git worktree:
 * commits, working tree and untracked files, WorkPilot's own files left out.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../cli-tool-manager", () => ({ getToolPath: () => "git" }));
vi.mock("../../ipc-handlers/task/worktree-diff-handlers", () => ({
	isWorkpilotArtifact: (p: string) => p.startsWith(".workpilot"),
}));

import { keepDiffSections, readWorktreeChangedFiles, readWorktreeDiff } from "../worktree-files";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });

let root: string;
let project: string;

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), "waves-"));
	project = path.join(root, "project");
	mkdirSync(project);
	git(project, "init", "-q", "-b", "main");
	git(project, "config", "user.email", "test@example.invalid");
	git(project, "config", "user.name", "Test");
	git(project, "config", "commit.gpgsign", "false");
	writeFileSync(path.join(project, "base.go"), "package base\n");
	writeFileSync(path.join(project, ".gitignore"), ".workpilot/\n");
	git(project, "add", ".");
	git(project, "commit", "-q", "-m", "base");

	const worktree = path.join(project, ".workpilot", "worktrees", "tasks", "001-cart");
	git(project, "worktree", "add", "-q", "-b", "workpilot/001-cart", worktree);
	writeFileSync(path.join(worktree, "cart.go"), "package cart\n");
	git(worktree, "add", "cart.go");
	git(worktree, "commit", "-q", "-m", "cart");
	writeFileSync(path.join(worktree, "base.go"), "package base // edited\n");
	writeFileSync(path.join(worktree, "notes.txt"), "untracked\n");
	writeFileSync(path.join(worktree, ".workpilot-discard-list"), "x\n");
	mkdirSync(path.join(worktree, "obj"));
	writeFileSync(path.join(worktree, "obj", "Shop.dll"), "build output\n");

	// A base branch known only as a remote ref (a clone that never checked it out).
	git(project, "update-ref", "refs/remotes/origin/trunk", "HEAD");

	// A task whose branch shares no history with any base.
	const orphan = path.join(project, ".workpilot", "worktrees", "tasks", "003-orphan");
	git(project, "worktree", "add", "-q", "--detach", orphan);
	git(orphan, "checkout", "-q", "--orphan", "workpilot/003-orphan");
	writeFileSync(path.join(orphan, "alone.txt"), "x\n");
	git(orphan, "add", "alone.txt");
	git(orphan, "commit", "-q", "-m", "orphan");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("readWorktreeChangedFiles", () => {
	it("lists committed, edited and untracked files of the task, not WorkPilot's or build output", async () => {
		const files = await readWorktreeChangedFiles(project, "001-cart", "main");
		expect(files?.sort()).toEqual(["base.go", "cart.go", "notes.txt"]);
	});

	it("falls back on the remote copy of the base branch", async () => {
		const files = await readWorktreeChangedFiles(project, "001-cart", "trunk");
		expect(files?.sort()).toEqual(["base.go", "cart.go", "notes.txt"]);
	});

	it("answers null when no base branch exists", async () => {
		expect(await readWorktreeChangedFiles(project, "001-cart", "nowhere")).toBeNull();
	});

	it("answers null when the task shares no history with its base", async () => {
		expect(await readWorktreeChangedFiles(project, "003-orphan", "main")).toBeNull();
	});

	it("answers null for a task with no worktree", async () => {
		expect(await readWorktreeChangedFiles(project, "002-none", "main")).toBeNull();
	});

	it("answers null for a spec id that leaves the project", async () => {
		expect(await readWorktreeChangedFiles(project, "../../../..", "main")).toBeNull();
	});
});

describe("readWorktreeDiff", () => {
	beforeAll(() => {
		const worktree = path.join(project, ".workpilot", "worktrees", "tasks", "004-diff");
		git(project, "worktree", "add", "-q", "-b", "workpilot/004-diff", worktree);
		writeFileSync(path.join(worktree, "base.go"), "package renamed_base\n");
		writeFileSync(path.join(worktree, ".workpilot-notes.txt"), "package spec_notes\n");
		mkdirSync(path.join(worktree, "obj"));
		writeFileSync(path.join(worktree, "obj", "Gen.cs"), "class build_output {}\n");
		git(worktree, "add", ".");
		git(worktree, "commit", "-q", "-m", "diff");

		// A worktree whose index git cannot read: the merge-base is found, the diff is not.
		const broken = path.join(project, ".workpilot", "worktrees", "tasks", "005-broken");
		git(project, "worktree", "add", "-q", "-b", "workpilot/005-broken", broken);
		const gitDir = git(broken, "rev-parse", "--absolute-git-dir").trim();
		writeFileSync(path.join(gitDir, "index"), "not an index");
	});

	it("gives the task's changes without context, WorkPilot's files and build output left out", async () => {
		const source = await readWorktreeDiff(project, "004-diff", "main");
		expect(source.worktree).toContain("004-diff");
		expect(source.diff).toContain("-package base");
		expect(source.diff).toContain("+package renamed_base");
		expect(source.diff).not.toContain("spec_notes");
		expect(source.diff).not.toContain("build_output");
	});

	it("keeps the worktree but no diff when git cannot give one", async () => {
		const source = await readWorktreeDiff(project, "005-broken", "main");
		expect(source.worktree).toContain("005-broken");
		expect(source.diff).toBeNull();
	});

	it("keeps the worktree but no diff when no base branch exists", async () => {
		const source = await readWorktreeDiff(project, "001-cart", "nowhere");
		expect(source.worktree).toContain("001-cart");
		expect(source.diff).toBeNull();
	});

	it("answers no worktree and no diff for a task without one", async () => {
		expect(await readWorktreeDiff(project, "002-none", "main")).toEqual({ worktree: null, diff: null });
	});
});

describe("keepDiffSections", () => {
	it("keeps the sections of the files kept, nothing before the first header", () => {
		const diff = [
			"warning: before any header",
			"diff --git a/src/a.ts b/src/a.ts",
			"@@ -1 +1 @@",
			"-oldName",
			"diff --git a/.env b/.env",
			"@@ -1 +1 @@",
			"-API_KEY=sk-test-0000",
			"diff --git a/dir with space/b.ts b/dir with space/b.ts",
			"+newName",
		].join("\n");
		const kept = keepDiffSections(diff, (file) => file !== ".env");
		expect(kept).toBe(
			[
				"diff --git a/src/a.ts b/src/a.ts",
				"@@ -1 +1 @@",
				"-oldName",
				"diff --git a/dir with space/b.ts b/dir with space/b.ts",
				"+newName",
			].join("\n"),
		);
	});
});
