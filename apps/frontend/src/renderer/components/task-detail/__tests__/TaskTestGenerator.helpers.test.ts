/**
 * The path arithmetic behind "write this generated test into the worktree".
 *
 * Now that the destination directory can be chosen by the user, a generated
 * file can land outside the worktree — and an absolute outside path joined onto
 * the worktree passes the main process's traversal check, quietly creating a
 * mirror of the machine's directory tree inside the task's diff.
 */

import { describe, expect, it } from "vitest";
import { toWorktreeRelativePath } from "../TaskTestGenerator";

const WORKTREE = "/home/me/.worktrees/task-42";

describe("toWorktreeRelativePath", () => {
	it("strips the worktree prefix", () => {
		expect(toWorktreeRelativePath(`${WORKTREE}/tests/AppTests.cs`, WORKTREE)).toBe(
			"tests/AppTests.cs",
		);
	});

	it("normalises Windows separators", () => {
		expect(
			toWorktreeRelativePath(
				"C:\\work\\task-42\\tests\\AppTests.cs",
				"C:\\work\\task-42",
			),
		).toBe("tests/AppTests.cs");
	});

	it("keeps an already relative path", () => {
		expect(toWorktreeRelativePath("tests/AppTests.cs", WORKTREE)).toBe(
			"tests/AppTests.cs",
		);
	});

	it("refuses an absolute path outside the worktree", () => {
		expect(
			toWorktreeRelativePath("/home/me/elsewhere/AppTests.cs", WORKTREE),
		).toBeNull();
	});
});
