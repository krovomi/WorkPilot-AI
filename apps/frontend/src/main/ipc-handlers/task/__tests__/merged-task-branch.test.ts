/**
 * A card merged locally ("Merge to main") and then moved to Done: its branch
 * is already on main, so there is no PR to open. Found by the Electron E2E
 * of the Kanban flow (e2e/kanban-flow.e2e.ts), where Done failed with "no
 * commit to push" and the card never left Human Review.
 *
 * Real repositories, real git: the answer comes from the history.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskWorkAlreadyMerged } from "../merged-task-branch";

const SPEC = "001-add-contributing";

let root: string;
let project: string;
let worktree: string;

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-c", "user.name=t", "-c", "user.email=t@e.invalid", ...args],
		{ cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
	);
}

function commitInWorktree(file: string): void {
	writeFileSync(path.join(worktree, file), "x\n");
	git(worktree, "add", file);
	git(worktree, "commit", "-qm", `add ${file}`);
}

const merged = (base = "main") =>
	taskWorkAlreadyMerged("git", project, worktree, SPEC, base);

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "merged-branch-"));
	project = path.join(root, "project");
	git(root, "init", "-q", "-b", "main", project);
	writeFileSync(path.join(project, "README.md"), "# p\n");
	git(project, "add", ".");
	git(project, "commit", "-qm", "init");
	worktree = path.join(root, "wt");
	git(project, "worktree", "add", "-q", "-b", `workpilot/${SPEC}`, worktree);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("taskWorkAlreadyMerged", () => {
	it("is false while the task branch has commits main lacks", () => {
		commitInWorktree("CONTRIBUTING.md");
		expect(merged()).toBe(false);
	});

	it("is true once main has merged the task branch", () => {
		commitInWorktree("CONTRIBUTING.md");
		git(project, "merge", "-q", "--no-ff", "-m", "merge", `workpilot/${SPEC}`);
		expect(merged()).toBe(true);
	});

	it("is false when the worktree still holds uncommitted work", () => {
		commitInWorktree("CONTRIBUTING.md");
		git(project, "merge", "-q", "--no-ff", "-m", "merge", `workpilot/${SPEC}`);
		writeFileSync(path.join(worktree, "notes.txt"), "not committed\n");
		expect(merged()).toBe(false);
	});

	it("is false when the base branch is unknown", () => {
		commitInWorktree("CONTRIBUTING.md");
		git(project, "merge", "-q", "--no-ff", "-m", "merge", `workpilot/${SPEC}`);
		expect(merged("develop")).toBe(false);
	});

	it("is false when the task branch does not exist", () => {
		expect(taskWorkAlreadyMerged("git", project, worktree, "999-none", "main")).toBe(false);
	});
});
