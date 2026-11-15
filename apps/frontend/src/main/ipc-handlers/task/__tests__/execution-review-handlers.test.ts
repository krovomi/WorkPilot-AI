/**
 * @vitest-environment node
 *
 * Approving or rejecting a task, on real repositories. Approval writes the QA
 * report. Rejection writes the fix request where the build runs (the
 * worktree), saves only images that are images and stay in their folder,
 * records the request as a subtask in both plans, reopens them with the
 * completed subtasks kept, and restarts the pipeline from the main project.
 *
 * A stage-only merge that left the task's changes staged in the main project
 * is taken back out, and only it: the person's own edits and untracked files
 * survive a rejection.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	found: {} as { task?: unknown; project?: unknown },
	serverCard: null as unknown,
	comments: [] as unknown[],
	serverReview: vi.fn(async () => ({ success: true, data: "server" })),
	uiEvent: vi.fn(),
	planFeedback: vi.fn(async () => undefined),
	logError: vi.fn(),
	logWarn: vi.fn(),
}));

vi.mock("../../../cli-tool-manager", () => ({ getToolPath: () => "git" }));
vi.mock("../../../server-board-actions", () => ({ findServerCard: () => state.serverCard }));
vi.mock("../../../server-board-review", () => ({ reviewServerCard: state.serverReview }));
vi.mock("../../../review-lessons", () => ({ recordPlanFeedback: state.planFeedback }));
vi.mock("../../../task-state-manager", () => ({ taskStateManager: { handleUiEvent: state.uiEvent } }));
vi.mock("../review-comments-handlers", () => ({
	openCommentsFor: (_task: string, ids: unknown) => (Array.isArray(ids) && ids.length ? state.comments : []),
}));
vi.mock("../shared", () => ({ findTaskAndProject: () => state.found }));
vi.mock("../../../app-logger", () => ({
	appLog: { info: vi.fn(), warn: state.logWarn, error: state.logError },
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { Task } from "../../../../shared/types";
import { parseStagedMerge, registerTaskReviewHandlers } from "../execution-review-handlers";

type Result = { success: boolean; error?: string; data?: unknown };
const review = (...args: unknown[]): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(IPC_CHANNELS.TASK_REVIEW, {}, "t1", ...args);

const agent = { startTaskExecution: vi.fn() };
registerTaskReviewHandlers({ agentManager: agent as never, getMainWindow: () => null });

let base = "";
let projectDir = "";
let specDir = "";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function setTask(over: Partial<Task> = {}, settings?: unknown): Task {
	const task = {
		id: "t1",
		specId: "001-x",
		title: "Add login",
		status: "human_review",
		subtasks: [],
		metadata: { baseBranch: "release", useWorktree: true },
		...over,
	} as Task;
	state.found = { task, project: { id: "p1", path: projectDir, settings } };
	return task;
}

function plan(dir: string, extra: object = {}): string {
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "implementation_plan.json");
	writeFileSync(
		file,
		JSON.stringify({
			status: "human_review",
			qa_signoff: { status: "approved" },
			phases: [
				{
					name: "Implementation",
					subtasks: [
						{ id: "a", status: "completed" },
						{ id: "b", status: "failed" },
					],
				},
				{ name: "Notes" },
			],
			...extra,
		}),
		"utf-8",
	);
	return file;
}
const read = (file: string) => JSON.parse(readFileSync(file, "utf-8"));

/** A worktree on its own branch, in the place the app looks for it. */
function addWorktree(): string {
	const wt = path.join(projectDir, ".workpilot", "worktrees", "tasks", "001-x");
	git(projectDir, "worktree", "add", "-q", "-b", "workpilot/001-x", wt);
	// The backend copies the spec into the worktree when the build starts.
	mkdirSync(path.join(wt, ".workpilot", "specs", "001-x"), { recursive: true });
	return wt;
}

let spies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
	base = mkdtempSync(path.join(tmpdir(), "exec-review-"));
	projectDir = path.join(base, "project");
	mkdirSync(projectDir);
	git(projectDir, "init", "-q", "-b", "main");
	// Windows runners check out CRLF otherwise, and the tests compare bytes.
	git(projectDir, "config", "core.autocrlf", "false");
	git(projectDir, "config", "user.email", "t@example.invalid");
	git(projectDir, "config", "user.name", "T");
	git(projectDir, "config", "commit.gpgsign", "false");
	writeFileSync(path.join(projectDir, ".gitignore"), ".workpilot/\n", "utf-8");
	writeFileSync(path.join(projectDir, "app.txt"), "v1\n", "utf-8");
	writeFileSync(path.join(projectDir, "mine.txt"), "mine v1\n", "utf-8");
	git(projectDir, "add", ".");
	git(projectDir, "commit", "-q", "-m", "init");
	specDir = path.join(projectDir, ".workpilot", "specs", "001-x");
	mkdirSync(specDir, { recursive: true });
	state.serverCard = null;
	state.comments = [];
	vi.clearAllMocks();
	spies = [vi.spyOn(console, "warn").mockImplementation(() => undefined)];
});
afterEach(() => {
	for (const spy of spies) spy.mockRestore();
	rmSync(base, { recursive: true, force: true });
});

describe("TASK_REVIEW", () => {
	it("hands a server card to the server", async () => {
		state.serverCard = { cardId: "001-a" };
		expect(await review(false, "fix it", [])).toEqual({ success: true, data: "server" });
		expect(state.serverReview).toHaveBeenCalledWith({ cardId: "001-a" }, false, "fix it", []);
	});

	it("answers for an unknown task", async () => {
		expect(await review(true)).toEqual({ success: false, error: "Task not found" });
	});

	describe("approval", () => {
		it("writes the QA report and marks the task done", async () => {
			const task = setTask();
			expect(await review(true)).toEqual({ success: true });
			expect(readFileSync(path.join(specDir, "qa_report.md"), "utf-8")).toMatch(
				/^# QA Review\n\nStatus: APPROVED\n\nReviewed at: /,
			);
			expect(state.uiEvent).toHaveBeenCalledWith("t1", { type: "MARK_DONE" }, task, expect.anything());
		});

		it("fails when the report cannot be written", async () => {
			setTask();
			rmSync(specDir, { recursive: true });
			expect(await review(true)).toEqual({ success: false, error: "Failed to write QA report file" });
			expect(state.uiEvent).not.toHaveBeenCalled();
		});
	});

	describe("rejection", () => {
		it("writes the request in the worktree, adds it to both plans and restarts the pipeline", async () => {
			const task = setTask({ reviewReason: "plan_review" } as Partial<Task>);
			const wt = addWorktree();
			const wtSpec = path.join(wt, ".workpilot", "specs", "001-x");
			const mainPlan = plan(specDir, { stagedInMainProject: false });
			const wtPlan = plan(wtSpec);

			expect(await review(false, "Use OAuth\nand keep the form")).toEqual({ success: true });

			const request = readFileSync(path.join(wtSpec, "QA_FIX_REQUEST.md"), "utf-8");
			expect(request).toMatch(/^# QA Fix Request\n\nStatus: REJECTED\n\n## Feedback\n\nUse OAuth\nand keep the form\n\nCreated at: /);
			for (const file of [mainPlan, wtPlan]) {
				const p = read(file);
				expect(p).toMatchObject({ status: "in_progress", planStatus: "in_progress", qa_signoff: { status: "pending" } });
				expect(p.stagedInMainProject).toBeUndefined();
				const subtasks = p.phases[0].subtasks;
				expect(subtasks.slice(0, 2)).toEqual([
					{ id: "a", status: "completed" },
					{ id: "b", status: "pending" },
				]);
				expect(subtasks[2]).toMatchObject({ title: "Use OAuth", origin: "change_request", status: "pending" });
			}
			expect(state.planFeedback).toHaveBeenCalledWith(projectDir, "001-x", "Use OAuth\nand keep the form");
			expect(agent.startTaskExecution).toHaveBeenCalledWith(
				"t1",
				projectDir,
				"001-x",
				{ baseBranch: "release", useWorktree: true, useLocalBranch: undefined, enableStreaming: true, streamingSessionId: "t1" },
				"p1",
			);
			expect(state.uiEvent).toHaveBeenCalledWith("t1", { type: "USER_RESUMED" }, task, expect.anything());
		});

		it("leaves the main project alone when nothing was staged there", async () => {
			setTask();
			addWorktree();
			// The person's own work in progress, staged, edited and untracked.
			writeFileSync(path.join(projectDir, "mine.txt"), "mine v2\n", "utf-8");
			git(projectDir, "add", "mine.txt");
			writeFileSync(path.join(projectDir, "app.txt"), "my edit\n", "utf-8");
			writeFileSync(path.join(projectDir, "notes.txt"), "draft\n", "utf-8");

			expect((await review(false, "again")).success).toBe(true);

			expect(readFileSync(path.join(projectDir, "mine.txt"), "utf-8")).toBe("mine v2\n");
			expect(git(projectDir, "diff", "--cached", "--name-only")).toBe("mine.txt");
			expect(readFileSync(path.join(projectDir, "app.txt"), "utf-8")).toBe("my edit\n");
			expect(readFileSync(path.join(projectDir, "notes.txt"), "utf-8")).toBe("draft\n");
		});

		it("takes a staged merge back out of the main project, and only it", async () => {
			const wt = addWorktree();
			writeFileSync(path.join(wt, "app.txt"), "v2 from the task\n", "utf-8");
			writeFileSync(path.join(wt, "feature.txt"), "new\n", "utf-8");
			rmSync(path.join(wt, "mine.txt"));
			git(wt, "add", "-A");
			git(wt, "commit", "-q", "-m", "task");
			// What the stage-only merge does in the main project.
			git(projectDir, "merge", "-q", "--no-commit", "--no-ff", "workpilot/001-x");
			// The person keeps an untracked note of their own beside it.
			writeFileSync(path.join(projectDir, "notes.txt"), "draft\n", "utf-8");
			setTask({ stagedInMainProject: true } as Partial<Task>);
			plan(specDir, { stagedInMainProject: true, stagedAt: "2026-11-14T00:00:00Z" });

			expect((await review(false, "no")).success).toBe(true);

			expect(git(projectDir, "status", "--porcelain")).toBe("?? notes.txt");
			expect(readFileSync(path.join(projectDir, "app.txt"), "utf-8")).toBe("v1\n");
			expect(readFileSync(path.join(projectDir, "mine.txt"), "utf-8")).toBe("mine v1\n");
			expect(existsSync(path.join(projectDir, "feature.txt"))).toBe(false);
			// The merge is closed: the next commit is the person's own.
			expect(existsSync(path.join(projectDir, ".git", "MERGE_HEAD"))).toBe(false);
			const p = read(path.join(specDir, "implementation_plan.json"));
			expect(p.stagedInMainProject).toBeUndefined();
			expect(p.stagedAt).toBeUndefined();
		});

		it("removes the files a merge only added", async () => {
			const wt = addWorktree();
			writeFileSync(path.join(wt, "only-new.txt"), "new\n", "utf-8");
			git(wt, "add", "only-new.txt");
			git(wt, "commit", "-q", "-m", "task");
			git(projectDir, "merge", "-q", "--no-commit", "--no-ff", "workpilot/001-x");
			setTask({ stagedInMainProject: true } as Partial<Task>);

			expect((await review(false, "no")).success).toBe(true);

			expect(git(projectDir, "status", "--porcelain")).toBe("");
			expect(existsSync(path.join(projectDir, "only-new.txt"))).toBe(false);
			expect(existsSync(path.join(projectDir, ".git", "MERGE_HEAD"))).toBe(false);
		});

		it("does nothing to a main project with nothing staged, or that git cannot read", async () => {
			setTask({ stagedInMainProject: true } as Partial<Task>);
			expect((await review(false, "no")).success).toBe(true);
			expect(git(projectDir, "status", "--porcelain")).toBe("");

			// A broken index: listing the staged paths fails, and nothing is touched.
			writeFileSync(path.join(projectDir, ".git", "index"), "broken", "utf-8");
			expect((await review(false, "no")).success).toBe(true);
			expect(state.logWarn).toHaveBeenCalledWith(expect.stringMatching(/^\[TASK_REVIEW\] Could not list the staged merge/));

			// Not a repository at all.
			rmSync(path.join(projectDir, ".git"), { recursive: true });
			writeFileSync(path.join(projectDir, ".git"), "gitdir: /nonexistent\n");
			expect((await review(false, "no")).success).toBe(true);
		});

		it("writes in the main spec without a worktree, from the review comments", async () => {
			setTask({ metadata: undefined }, { mainBranch: "trunk" });
			const mainPlan = plan(specDir);
			state.comments = [{ id: "c1", path: "src/a.ts", line: 3, side: "new", excerpt: ["x()"], text: "rename" }];

			expect((await review(false, "", [], ["c1"])).success).toBe(true);

			const request = readFileSync(path.join(specDir, "QA_FIX_REQUEST.md"), "utf-8");
			expect(request).toContain("## Feedback\n\nSee the review comments below.\n\n## Review comments");
			expect(request).toContain("### src/a.ts:3\n```\nx()\n```\n> rename");
			const subtasks = read(mainPlan).phases[0].subtasks;
			expect(subtasks).toHaveLength(3);
			expect(subtasks[2].title).toBe("Needs fixes based on user feedback");
			expect(agent.startTaskExecution.mock.calls[0][3]).toMatchObject({ baseBranch: "trunk", useWorktree: undefined });
			expect(state.planFeedback).not.toHaveBeenCalled();
		});

		it("says so when there is no feedback at all, and survives plans it cannot read", async () => {
			setTask();
			mkdirSync(path.join(specDir, "implementation_plan.json"));
			expect((await review(false)).success).toBe(true);
			expect(readFileSync(path.join(specDir, "QA_FIX_REQUEST.md"), "utf-8")).toContain("No feedback provided");
			expect(state.logWarn).toHaveBeenCalledWith(expect.stringMatching(/^\[TASK_REVIEW\] Could not reset plan /));

			// A plan with no phases is still reopened.
			rmSync(path.join(specDir, "implementation_plan.json"), { recursive: true });
			writeFileSync(path.join(specDir, "implementation_plan.json"), JSON.stringify({ status: "done" }));
			expect((await review(false, "x")).success).toBe(true);
			const p = read(path.join(specDir, "implementation_plan.json"));
			expect(p.status).toBe("in_progress");
			expect(p.phases[0].subtasks[0].origin).toBe("change_request");
		});

		it("fails when the fix request cannot be written", async () => {
			setTask();
			rmSync(specDir, { recursive: true });
			expect(await review(false, "x")).toEqual({ success: false, error: "Failed to write QA fix request file" });
			expect(agent.startTaskExecution).not.toHaveBeenCalled();
		});

		it("refuses a feedback that is not text, before touching anything", async () => {
			setTask();
			const p = plan(specDir);
			const before = readFileSync(p, "utf-8");
			expect(await review(false, { not: "text" })).toEqual({ success: false, error: "Invalid feedback" });
			expect(readFileSync(p, "utf-8")).toBe(before);
			expect(existsSync(path.join(specDir, "QA_FIX_REQUEST.md"))).toBe(false);
			expect(agent.startTaskExecution).not.toHaveBeenCalled();
			// null is no feedback, as undefined is.
			expect((await review(false, null)).success).toBe(true);
		});

		it("saves the images that are images, inside their folder only", async () => {
			setTask();
			const png = Buffer.from("png-bytes").toString("base64");
			const images = [
				{ filename: "shot.png", mimeType: "image/png", data: `data:image/png;base64,${png}` },
				{ filename: "../../escape.png", mimeType: "image/png", data: png },
				{ filename: "nodata.png", mimeType: "image/png", data: "" },
				{ filename: "script.html", mimeType: "text/html", data: png },
				{ filename: "nomime.png", data: png },
				{ filename: "..", mimeType: "image/png", data: png },
				{ filename: "", mimeType: "image/png", data: png },
			];
			expect((await review(false, "see", images)).success).toBe(true);

			const dir = path.join(specDir, "feedback_images");
			expect(readdirSync(dir).sort()).toEqual(["escape.png", "shot.png"]);
			expect(readFileSync(path.join(dir, "shot.png"), "utf-8")).toBe("png-bytes");
			expect(existsSync(path.join(projectDir, ".workpilot", "escape.png"))).toBe(false);
			const request = readFileSync(path.join(specDir, "QA_FIX_REQUEST.md"), "utf-8");
			expect(request).toContain(
				"## Reference Images\n\n![Feedback Image](feedback_images/shot.png)\n\n![Feedback Image](feedback_images/escape.png)",
			);
		});

		it("reports an image it cannot save, and a folder it cannot create", async () => {
			setTask();
			const png = Buffer.from("x").toString("base64");
			mkdirSync(path.join(specDir, "feedback_images", "taken.png"), { recursive: true });
			expect((await review(false, "see", [{ filename: "taken.png", mimeType: "image/png", data: png }])).success).toBe(
				true,
			);
			expect(state.logError).toHaveBeenCalledWith("[TASK_REVIEW] Failed to save image:", "taken.png", expect.anything());
			expect(readFileSync(path.join(specDir, "QA_FIX_REQUEST.md"), "utf-8")).not.toContain("Reference Images");

			rmSync(path.join(specDir, "feedback_images"), { recursive: true });
			writeFileSync(path.join(specDir, "feedback_images"), "a file", "utf-8");
			expect((await review(false, "see", [{ filename: "a.png", mimeType: "image/png", data: png }])).success).toBe(
				true,
			);
			expect(state.logError).toHaveBeenCalledWith("[TASK_REVIEW] Failed to create images directory:", expect.anything());
		});
	});
});

describe("parseStagedMerge", () => {
	it("splits added from changed paths and drops one that would leave the repository", () => {
		const root = path.join(tmpdir(), "repo");
		const output = ["A", "new.ts", "M", "src/a.ts", "D", "old.ts", "A", "../escape.txt", "M", path.join("..", "..", "etc", "x"), "A"].join("\0");

		expect(parseStagedMerge(`${output}\0`, root)).toEqual({
			added: ["new.ts"],
			changed: ["src/a.ts", "old.ts"],
		});
		expect(parseStagedMerge("", root)).toEqual({ added: [], changed: [] });
	});
});
