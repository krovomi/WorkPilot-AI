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

import { readWorktreeChangedFiles } from "../worktree-files";

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
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("readWorktreeChangedFiles", () => {
	it("lists committed, edited and untracked files of the task", async () => {
		const files = await readWorktreeChangedFiles(project, "001-cart", "main");
		expect(files?.sort()).toEqual(["base.go", "cart.go", "notes.txt"]);
	});

	it("answers null for a task with no worktree", async () => {
		expect(await readWorktreeChangedFiles(project, "002-none", "main")).toBeNull();
	});

	it("answers null for a spec id that leaves the project", async () => {
		expect(await readWorktreeChangedFiles(project, "../../../..", "main")).toBeNull();
	});
});
