/**
 * @vitest-environment node
 *
 * The guided review over IPC, on a real repository: each recorded subtask
 * gets its own range, an unrecorded commit and the uncommitted changes get
 * their own group, and the renderer can name nothing but a task.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	repo: "",
	specDir: "",
	card: null as null | { cardId: string },
}));

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../../cli-tool-manager", () => ({ getToolPath: () => "git" }));
vi.mock("../../../server-board-actions", () => ({ findServerCard: () => state.card }));
vi.mock("../../../worktree-paths", () => ({ findTaskWorktree: () => state.repo }));
vi.mock("../shared", () => ({
	findTaskAndProject: (id: string) =>
		id === "task-1"
			? { task: { id, specId: "001-orders" }, project: { path: "/unused", settings: {} } }
			: { task: null, project: null },
}));
vi.mock("../resume-task", () => ({
	getSpecPaths: () => ({ worktreeSpecDir: state.specDir, mainSpecDir: null, specDir: null }),
}));
vi.mock("../worktree-diff-handlers", () => ({
	isWorkpilotArtifact: (p: string) => p.startsWith(".workpilot"),
}));
vi.mock("../worktree-git-refs", () => ({
	getEffectiveBaseBranch: () => "main",
	resolveDiffRefs: () => ({ baseRef: "main", headRef: "HEAD", usingRemoteHead: false }),
}));

import { reviewGroups } from "../review-groups-handlers";

function git(...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
		cwd: state.repo,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

function commit(files: Record<string, string>, message: string): string {
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(path.join(state.repo, name), content, "utf-8");
	}
	git("add", "-A");
	git("commit", "-q", "-m", message);
	return git("rev-parse", "HEAD");
}

beforeEach(() => {
	state.repo = mkdtempSync(path.join(tmpdir(), "review-groups-"));
	state.card = null;
	git("init", "-q", "-b", "main");
	writeFileSync(path.join(state.repo, ".gitignore"), ".workpilot/\n", "utf-8");
	const base = commit({ "api.ts": "export const routes = [];\n" }, "base");
	git("checkout", "-q", "-b", "workpilot/001-orders");
	const c1 = commit({ "api.ts": "export const routes = ['/orders'];\n" }, "subtask-1");
	const c2 = commit({ "README.md": "# Orders\n" }, "docs by hand");
	const c3 = commit({ "api.test.ts": "test('orders')\n", "util.ts": "export {};\n" }, "subtask-2");
	writeFileSync(path.join(state.repo, "notes.md"), "todo\n", "utf-8");

	state.specDir = path.join(state.repo, ".workpilot", "specs", "001-orders");
	mkdirSync(path.join(state.specDir, "memory"), { recursive: true });
	writeFileSync(
		path.join(state.specDir, "implementation_plan.json"),
		JSON.stringify({
			phases: [
				{
					subtasks: [
						{ id: "subtask-1", description: "Add the orders route", files_to_modify: ["api.ts"] },
						{ id: "subtask-2", description: "Test the route", files_to_create: ["api.test.ts"] },
					],
				},
			],
			qa_iteration_history: [{ issues: [{ file: "api.ts", line: 1, title: "No auth", severity: "major" }] }],
		}),
		"utf-8",
	);
	writeFileSync(
		path.join(state.specDir, "memory", "build_commits.json"),
		JSON.stringify({
			commits: [
				{ hash: c1, subtask_id: "subtask-1", commit_before: base },
				{ hash: c3, subtask_id: "subtask-2", commit_before: c2 },
			],
		}),
		"utf-8",
	);
});

describe("TASK_REVIEW_GROUPS", () => {
	it("groups the diff by subtask, then unrecorded commits, then uncommitted changes", async () => {
		const result = await reviewGroups("task-1");
		expect(result.success).toBe(true);
		if (!result.success || !result.data) return;
		const { groups, outOfPlan, approximate } = result.data;
		expect(approximate).toBe(false);
		expect(groups.map((g) => [g.kind, g.title, g.files.map((f) => f.path).sort()])).toEqual([
			["subtask", "Add the orders route", ["api.ts"]],
			["subtask", "Test the route", ["api.test.ts", "util.ts"]],
			["commit", "docs by hand", ["README.md"]],
			["uncommitted", "", ["notes.md"]],
		]);
		// The range diff is the subtask's own change, not the final file.
		expect(groups[0].files[0].patch).toContain("+export const routes = ['/orders'];");
		expect(groups[0].files[0].qaNotes.map((n) => n.title)).toEqual(["No auth"]);
		// WorkPilot's own files are never part of the review.
		expect(groups.flatMap((g) => g.files.map((f) => f.path)).filter((p) => p.startsWith(".workpilot"))).toEqual([]);
		expect(outOfPlan).toEqual(["README.md", "notes.md", "util.ts"]);
	});

	it.each([[""], [42], ["../../etc/passwd"], ["x".repeat(400)]])(
		"accepts nothing but a known task id (%j)",
		async (taskId) => {
			expect(await reviewGroups(taskId)).toEqual({ success: false, error: "task_not_found" });
		},
	);

	it("leaves a server card to the flat diff", async () => {
		state.card = { cardId: "c" };
		expect(await reviewGroups("task-1")).toEqual({ success: false, error: "local_only" });
	});
});
