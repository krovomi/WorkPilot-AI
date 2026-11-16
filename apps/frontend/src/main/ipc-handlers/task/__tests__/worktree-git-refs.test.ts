/**
 * @vitest-environment node
 *
 * The base branch a task diffs against, on real repositories: the task's
 * own choice first, then the project's, then what git says (the remote's
 * HEAD, then main, master or develop), and the remote refs preferred for a
 * diff once the branch was pushed. Never a hard-coded branch that does not
 * exist.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../cli-tool-manager", () => ({ getToolPath: () => "git" }));

import {
	detectGitDefaultBranch,
	getEffectiveBaseBranch,
	getTaskBaseBranch,
	gitRefExists,
	resolveDiffRefs,
} from "../worktree-git-refs";

let base = "";
beforeEach(() => {
	base = mkdtempSync(path.join(tmpdir(), "wt-refs-"));
});
afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function repo(name: string, branch: string): string {
	const dir = path.join(base, name);
	mkdirSync(dir);
	git(dir, "init", "-q", "-b", branch);
	git(dir, "config", "user.email", "test@example.invalid");
	git(dir, "config", "user.name", "Test");
	git(dir, "commit", "-q", "--allow-empty", "-m", "init");
	return dir;
}

function metadata(project: string, spec: string, content: string): void {
	const dir = path.join(project, ".workpilot", "specs", spec);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "task_metadata.json"), content, "utf-8");
}

describe("getTaskBaseBranch", () => {
	it("reads a valid base branch and ignores the project-default marker or a bad name", () => {
		const project = path.join(base, "p");
		metadata(project, "s1", JSON.stringify({ baseBranch: "release/2.0" }));
		expect(getTaskBaseBranch(path.join(project, ".workpilot", "specs", "s1"))).toBe("release/2.0");
		metadata(project, "s2", JSON.stringify({ baseBranch: "__project_default__" }));
		expect(getTaskBaseBranch(path.join(project, ".workpilot", "specs", "s2"))).toBeUndefined();
		metadata(project, "s3", JSON.stringify({ baseBranch: "main; rm -rf" }));
		expect(getTaskBaseBranch(path.join(project, ".workpilot", "specs", "s3"))).toBeUndefined();
		expect(getTaskBaseBranch(path.join(project, "nowhere"))).toBeUndefined();
	});

	it("survives a broken file and a missing argument", () => {
		const project = path.join(base, "p");
		metadata(project, "s", "{ broken");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(getTaskBaseBranch(path.join(project, ".workpilot", "specs", "s"))).toBeUndefined();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(getTaskBaseBranch(undefined as never)).toBeUndefined();
		error.mockRestore();
	});
});

describe("getEffectiveBaseBranch", () => {
	it("prefers the task's branch, then the project's, then git's", () => {
		const project = repo("p", "trunk");
		metadata(project, "s", JSON.stringify({ baseBranch: "feature/x" }));
		expect(getEffectiveBaseBranch(project, "s", "develop")).toBe("feature/x");
		expect(getEffectiveBaseBranch(project, "other", "develop")).toBe("develop");
		expect(getEffectiveBaseBranch(project, "other", "bad name")).toBe("main");
	});

	it("answers main for missing arguments", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(getEffectiveBaseBranch("", "s")).toBe("main");
		expect(getEffectiveBaseBranch(base, undefined as never)).toBe("main");
		error.mockRestore();
	});
});

describe("detectGitDefaultBranch", () => {
	it("reads the remote's default branch when origin/HEAD is set", () => {
		const upstream = repo("upstream", "production");
		const clone = path.join(base, "clone");
		git(base, "clone", "-q", upstream, clone);
		expect(detectGitDefaultBranch(clone)).toBe("production");
	});

	it("ignores an origin/HEAD that names no valid branch", () => {
		const dir = repo("odd", "master");
		git(dir, "update-ref", "refs/remotes/origin/-bad", "HEAD");
		git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/-bad");
		expect(detectGitDefaultBranch(dir)).toBe("master");
	});

	it("tries main, master and develop in turn, and falls back to main", () => {
		expect(detectGitDefaultBranch(repo("m", "master"))).toBe("master");
		expect(detectGitDefaultBranch(repo("d", "develop"))).toBe("develop");
		expect(detectGitDefaultBranch(repo("t", "trunk"))).toBe("main");
	});
});

describe("resolveDiffRefs", () => {
	it("uses the local refs until the branch and its base exist on origin", () => {
		const upstream = repo("up", "main");
		const clone = path.join(base, "work");
		git(base, "clone", "-q", upstream, clone);
		git(clone, "config", "user.email", "test@example.invalid");
		git(clone, "config", "user.name", "Test");
		git(clone, "checkout", "-q", "-b", "workpilot/001");
		expect(resolveDiffRefs(clone, "workpilot/001", "main")).toEqual({
			baseRef: "origin/main",
			headRef: "HEAD",
			usingRemoteHead: false,
		});
		git(clone, "push", "-q", "origin", "workpilot/001");
		expect(resolveDiffRefs(clone, "workpilot/001", "gone")).toEqual({
			baseRef: "gone",
			headRef: "origin/workpilot/001",
			usingRemoteHead: true,
		});
		expect(gitRefExists(clone, "nope")).toBe(false);
	});
});
