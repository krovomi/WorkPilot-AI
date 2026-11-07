/**
 * @vitest-environment node
 *
 * Line comments over IPC, on a real repository: the path must stay inside
 * the task's worktree, the excerpt is read by the main process, every spec
 * copy is written, a comment whose lines are gone turns stale, and only the
 * open comments the request names reach QA_FIX_REQUEST.md.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ repo: "", dirs: [] as string[], card: null as null | { cardId: string } }));

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../../cli-tool-manager", () => ({ getToolPath: () => "git" }));
vi.mock("../../../server-board-actions", () => ({ findServerCard: () => state.card }));
vi.mock("../../../worktree-paths", () => ({ findTaskWorktree: () => state.repo }));
vi.mock("../shared", () => ({
	findTaskAndProject: (id: string) =>
		id === "task-1" ? { task: { id, specId: "001" }, project: { path: "/unused" } } : { task: null, project: null },
}));
vi.mock("../resume-task", () => ({ getSpecPaths: () => ({}), allSpecDirs: () => state.dirs }));

import { addReviewComment, listReviewComments, openCommentsFor, updateReviewComment } from "../review-comments-handlers";

const SERVICE = "class OrderService {\n  total(order) {\n    return order.items.sum();\n  }\n}\n";

function git(...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
		cwd: state.repo,
		encoding: "utf-8",
	}).trim();
}

beforeEach(() => {
	const root = mkdtempSync(path.join(tmpdir(), "review-comments-"));
	state.repo = path.join(root, "wt");
	mkdirSync(path.join(state.repo, "src"), { recursive: true });
	git("init", "-q", "-b", "main");
	writeFileSync(path.join(state.repo, "src", "OrderService.ts"), SERVICE, "utf-8");
	git("add", "-A");
	git("commit", "-q", "-m", "base");
	state.dirs = [path.join(root, "spec-a"), path.join(root, "spec-b")];
	for (const d of state.dirs) mkdirSync(d, { recursive: true });
	state.card = null;
});

describe("review comments handlers", () => {
	it("anchors a comment with the excerpt it reads, in every spec copy", async () => {
		const result = await addReviewComment("task-1", { path: "src/OrderService.ts", side: "new", line: 3, text: "Null order?" });
		expect(result.success).toBe(true);
		const [c] = result.data ?? [];
		expect(c.excerpt).toEqual(["  total(order) {", "    return order.items.sum();", "  }"]);
		expect(c.commit).toBe(git("rev-parse", "HEAD"));
		for (const d of state.dirs) {
			expect(readFileSync(path.join(d, "review-comments.json"), "utf-8")).toContain("Null order?");
		}
	});

	it.each([
		[{ path: "../outside.ts", line: 1, text: "x" }, "invalid_path"],
		[{ path: "src/missing.ts", line: 1, text: "x" }, "invalid_path"],
		[{ path: "src/OrderService.ts", line: 99, text: "x" }, "invalid_line"],
		[{ path: "src/OrderService.ts", line: 1, text: "x", commit: "deadbeef" }, "invalid_commit"],
	])("refuses %j", async (input, error) => {
		expect(await addReviewComment("task-1", input)).toEqual({ success: false, error });
	});

	it("refuses a link that leaves the worktree", async () => {
		const outside = path.join(path.dirname(state.repo), "secret.txt");
		writeFileSync(outside, "token\n", "utf-8");
		symlinkSync(outside, path.join(state.repo, "src", "link.txt"));
		expect(await addReviewComment("task-1", { path: "src/link.txt", line: 1, text: "x" })).toEqual({
			success: false,
			error: "invalid_path",
		});
	});

	it("marks stale a comment whose lines are gone, and lets the person resolve one", async () => {
		const added = await addReviewComment("task-1", { path: "src/OrderService.ts", line: 3, text: "Null order?" });
		const id = added.data?.[0].id ?? "";
		writeFileSync(path.join(state.repo, "src", "OrderService.ts"), "export {};\n", "utf-8");
		expect((await listReviewComments("task-1")).data?.[0].status).toBe("stale");
		expect((await updateReviewComment("task-1", id, "resolve")).data?.[0].status).toBe("resolved");
		expect(await updateReviewComment("task-1", id, "approve")).toEqual({ success: false, error: "invalid_action" });
	});

	it("gives the fixer only the open comments the request names, at their current line", async () => {
		const first = await addReviewComment("task-1", { path: "src/OrderService.ts", line: 3, text: "Null order?" });
		const second = await addReviewComment("task-1", { path: "src/OrderService.ts", line: 1, text: "Rename" });
		const [a, b] = second.data ?? [];
		await updateReviewComment("task-1", b.id, "resolve");
		writeFileSync(path.join(state.repo, "src", "OrderService.ts"), `// header\n${SERVICE}`, "utf-8");
		const sent = openCommentsFor("task-1", [a.id, b.id, "made-up"]);
		expect(sent.map((c) => [c.id, c.line])).toEqual([[first.data?.[0].id, 4]]);
		expect(openCommentsFor("task-1", "not a list")).toEqual([]);
	});

	it("names nothing but a task, and leaves a server card alone", async () => {
		expect(await listReviewComments("../../x")).toEqual({ success: false, error: "task_not_found" });
		state.card = { cardId: "c" };
		expect(await listReviewComments("task-1")).toEqual({ success: false, error: "local_only" });
	});
});
