/**
 * The review's "Fichiers modifiés" list: a file the agent created but never
 * committed must show up, and a git failure must not read as "0 files".
 *
 * Real git in a temp directory: what counts as changed is git's answer.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	collectWorktreeDiffFiles,
	parseDiffSections,
} from "../worktree-diff-files";

let repo: string;

function git(args: string[], cwd = repo): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	});
}

const localRefs = {
	baseRef: "main",
	headRef: "HEAD",
	usingRemoteHead: false,
};

beforeEach(() => {
	repo = mkdtempSync(path.join(tmpdir(), "wp-worktree-diff-"));
	git(["init", "-q", "-b", "main"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "Test"]);
	git(["config", "core.autocrlf", "false"]);
	writeFileSync(path.join(repo, "README.md"), "hello\n", "utf-8");
	git(["add", "README.md"]);
	git(["commit", "-q", "-m", "init"]);
	git(["checkout", "-q", "-b", "workpilot/001-task"]);
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("collectWorktreeDiffFiles", () => {
	it("lists a committed new file", () => {
		writeFileSync(path.join(repo, "toto.txt"), "toto\n", "utf-8");
		git(["add", "toto.txt"]);
		git(["commit", "-q", "-m", "add toto"]);

		const files = collectWorktreeDiffFiles("git", repo, localRefs);

		expect(files).toEqual([
			expect.objectContaining({
				path: "toto.txt",
				status: "added",
				additions: 1,
				deletions: 0,
			}),
		]);
	});

	it("lists a file the agent created but never committed", () => {
		writeFileSync(path.join(repo, "toto.txt"), "a\nb\n", "utf-8");

		const files = collectWorktreeDiffFiles("git", repo, localRefs);

		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({
			path: "toto.txt",
			status: "added",
			additions: 2,
		});
		expect(files[0].patch).toContain("+a\n+b");
	});

	it("lists staged and unstaged edits of tracked files", () => {
		writeFileSync(path.join(repo, "README.md"), "hello\nworld\n", "utf-8");
		writeFileSync(path.join(repo, "staged.txt"), "x\n", "utf-8");
		git(["add", "staged.txt"]);

		const files = collectWorktreeDiffFiles("git", repo, localRefs);

		expect(files.map((f) => f.path).sort()).toEqual([
			"README.md",
			"staged.txt",
		]);
		expect(files.find((f) => f.path === "README.md")).toMatchObject({
			status: "modified",
			additions: 1,
		});
	});

	it("ignores what the base branch changed since the task started", () => {
		git(["checkout", "-q", "main"]);
		writeFileSync(path.join(repo, "other.txt"), "base\n", "utf-8");
		git(["add", "other.txt"]);
		git(["commit", "-q", "-m", "base moves on"]);
		git(["checkout", "-q", "workpilot/001-task"]);
		writeFileSync(path.join(repo, "toto.txt"), "toto\n", "utf-8");

		const files = collectWorktreeDiffFiles("git", repo, localRefs);

		expect(files.map((f) => f.path)).toEqual(["toto.txt"]);
	});

	it("drops hidden untracked paths and lists binaries without content", () => {
		mkdirSync(path.join(repo, "obj"));
		writeFileSync(path.join(repo, "obj", "cache.bin"), "x", "utf-8");
		writeFileSync(path.join(repo, "image.bin"), "a\0b", "utf-8");

		const files = collectWorktreeDiffFiles("git", repo, localRefs, (p) =>
			p.startsWith("obj/"),
		);

		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({ path: "image.bin", additions: 0 });
		expect(files[0].patch).toContain("Binary files");
	});

	it("reads a diff larger than Node's 1 MB default buffer", () => {
		// Build outputs committed by an earlier auto-save made the real diff
		// overflow execFileSync's default maxBuffer: the list came back empty.
		const big = `${"x".repeat(100)}\n`.repeat(20_000);
		writeFileSync(path.join(repo, "generated.txt"), big, "utf-8");
		writeFileSync(path.join(repo, "toto.txt"), "OK\n", "utf-8");
		git(["add", "."]);
		git(["commit", "-q", "-m", "agent"]);

		const files = collectWorktreeDiffFiles("git", repo, localRefs);

		expect(files.map((f) => f.path).sort()).toEqual([
			"generated.txt",
			"toto.txt",
		]);
	});

	it("lists a large untracked file without its content", () => {
		writeFileSync(path.join(repo, "big.log"), "y".repeat(600 * 1024), "utf-8");

		const files = collectWorktreeDiffFiles("git", repo, localRefs);

		expect(files).toEqual([
			{ path: "big.log", status: "added", additions: 0, deletions: 0 },
		]);
	});

	it("throws instead of answering an empty list when git fails", () => {
		expect(() =>
			collectWorktreeDiffFiles("git", repo, {
				...localRefs,
				baseRef: "does-not-exist",
			}),
		).toThrow();
	});

	it("reads only the published range when the head is remote", () => {
		writeFileSync(path.join(repo, "local-only.txt"), "x\n", "utf-8");
		writeFileSync(path.join(repo, "pushed.txt"), "p\n", "utf-8");
		git(["add", "pushed.txt"]);
		git(["commit", "-q", "-m", "pushed"]);

		const files = collectWorktreeDiffFiles("git", repo, {
			baseRef: "main",
			headRef: "HEAD",
			usingRemoteHead: true,
		});

		expect(files.map((f) => f.path)).toEqual(["pushed.txt"]);
	});
});

describe("parseDiffSections", () => {
	it("returns nothing for an empty diff", () => {
		expect(parseDiffSections("")).toEqual([]);
	});
});
