import { describe, expect, it } from "vitest";
import {
	filesFromSubtasks,
	resolveTaskFiles,
	sortTaskFiles,
} from "./task-files-model";

describe("filesFromSubtasks", () => {
	it("lists each recorded file once, in first-seen order, with / separators", () => {
		expect(
			filesFromSubtasks([
				{ files: ["src\\b.cs", "./test.txt"] },
				{ files: ["test.txt", "", "src/b.cs"] },
			]).map((f) => f.path),
		).toEqual(["src/b.cs", "test.txt"]);
	});

	it("is empty without subtasks", () => {
		expect(filesFromSubtasks(undefined)).toEqual([]);
	});
});

describe("sortTaskFiles", () => {
	it("puts the files the task created first", () => {
		expect(
			sortTaskFiles([
				{ path: "a.txt", status: "modified" },
				{ path: "z.txt", status: "added" },
				{ path: "b.txt", status: "deleted" },
			]).map((f) => f.path),
		).toEqual(["z.txt", "a.txt", "b.txt"]);
	});
});

describe("resolveTaskFiles", () => {
	const worktreePath = "/repo/.workpilot/worktrees/tasks/001-test";

	it("lists the worktree diff, read from the worktree", () => {
		const result = resolveTaskFiles({
			diff: {
				success: true,
				files: [
					{ path: "test.txt", status: "added", additions: 1, deletions: 0 },
				],
			},
			worktreePath,
			projectPath: "/repo",
			subtasks: [{ files: ["other.txt"] }],
		});
		expect(result.source).toBe("worktree");
		expect(result.root).toBe(worktreePath);
		expect(result.files).toEqual([
			{
				path: "test.txt",
				status: "added",
				additions: 1,
				deletions: 0,
				patch: undefined,
			},
		]);
		expect(result.error).toBeNull();
	});

	it("falls back to the subtasks' files, read from the project, once the worktree is gone", () => {
		const result = resolveTaskFiles({
			diff: { success: false, error: "No worktree found for this task" },
			worktreePath: null,
			projectPath: "/repo",
			subtasks: [{ files: ["test.txt"] }],
		});
		expect(result.source).toBe("subtasks");
		expect(result.root).toBe("/repo");
		expect(result.files).toEqual([{ path: "test.txt", status: "unknown" }]);
		expect(result.error).toBeNull();
	});

	it("falls back to the subtasks' files when the merged branch has no diff left", () => {
		const result = resolveTaskFiles({
			diff: { success: true, files: [] },
			worktreePath,
			projectPath: "/repo",
			subtasks: [{ files: ["test.txt"] }],
		});
		expect(result.source).toBe("subtasks");
		expect(result.root).toBe(worktreePath);
	});

	it("reports a git failure of an existing worktree instead of an empty list", () => {
		const result = resolveTaskFiles({
			diff: { success: false, error: "fatal: bad revision 'main'" },
			worktreePath,
			projectPath: "/repo",
			subtasks: [],
		});
		expect(result.files).toEqual([]);
		expect(result.error).toBe("fatal: bad revision 'main'");
	});

	it("is quietly empty for a task that has no worktree yet", () => {
		const result = resolveTaskFiles({
			diff: { success: false, error: "No worktree found for this task" },
			worktreePath: null,
			projectPath: "/repo",
			subtasks: [],
		});
		expect(result).toEqual({
			files: [],
			root: null,
			source: "none",
			error: null,
		});
	});
});
