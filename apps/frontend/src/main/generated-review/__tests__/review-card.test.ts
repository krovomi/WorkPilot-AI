/**
 * A page's generated code waits on a Kanban card, on its own branch.
 *
 * What matters: the code never goes to the project folder, one card holds the
 * runs of a page until its pull request is opened, and a run that wrote
 * nothing leaves nothing behind. The worktree runner (Python, tested in
 * tests/test_review_worktree_runner.py) is replaced by a fake that makes the
 * folder the real one would.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../shared/types";
import {
	findOpenReviewCard,
	openReviewWorkspace,
	recordReviewStep,
	type ReviewDeps,
	toWorkspacePath,
} from "../review-card";

vi.mock("../../project-store", () => ({
	projectStore: { invalidateTasksCache: vi.fn() },
}));
vi.mock("../../utils/worktree-cleanup", () => ({ cleanupWorktree: vi.fn() }));
vi.mock("../../app-language", () => ({ getAppLanguage: () => "fr" }));

let root: string;
let project: Project;
let calls: string[][];
let commitAnswer: Record<string, unknown>;
let deps: ReviewDeps & { cleanup: ReturnType<typeof vi.fn> };

const specOf = (args: string[]) => args[args.indexOf("--spec") + 1];
const worktreeOf = (spec: string) => path.join(root, ".workpilot", "worktrees", "tasks", spec);
const readSpec = (spec: string, file: string) =>
	JSON.parse(readFileSync(path.join(root, ".workpilot", "specs", spec, file), "utf-8"));

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "generated-review-"));
	project = {
		id: "proj-1",
		name: "Demo",
		path: root,
		autoBuildPath: ".workpilot",
		settings: { mainBranch: "develop" },
	} as unknown as Project;
	calls = [];
	commitAnswer = { committed: true, files: ["tests/test_a.py"] };
	deps = {
		language: () => "fr",
		cleanup: vi.fn(async (options: { worktreePath: string }) => {
			rmSync(options.worktreePath, { recursive: true, force: true });
			return { success: true, warnings: [] };
		}),
		run: async (args) => {
			calls.push(args);
			const spec = specOf(args);
			if (args.includes("create")) {
				mkdirSync(worktreeOf(spec), { recursive: true });
				return { path: worktreeOf(spec), branch: `workpilot/${spec}`, base_branch: "develop" };
			}
			return commitAnswer;
		},
	} as ReviewDeps & { cleanup: ReturnType<typeof vi.fn> };
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("openReviewWorkspace", () => {
	it("opens a generated card and its worktree on the project's base branch", async () => {
		const ws = await openReviewWorkspace(
			project,
			{ source: "test-studio", subject: "Program.cs" },
			deps,
		);

		expect(ws.reused).toBe(false);
		expect(ws.title).toBe("Tests générés : Program.cs");
		expect(ws.worktreePath).toBe(worktreeOf(ws.specId));
		expect(ws.branch).toBe(`workpilot/${ws.specId}`);
		expect(calls[0]).toEqual([
			"--action",
			"create",
			"--project-dir",
			root,
			"--spec",
			ws.specId,
			"--base-branch",
			"develop",
		]);
		expect(readSpec(ws.specId, "task_metadata.json")).toMatchObject({
			sourceType: "generated",
			generatedBy: "test-studio",
			baseBranch: "develop",
		});
	});

	it("leaves no card behind when the worktree cannot be made", async () => {
		deps = { ...deps, run: async () => Promise.reject(new Error("not a git repository")) };

		await expect(
			openReviewWorkspace(project, { source: "test-studio", subject: "x" }, deps),
		).rejects.toThrow("not a git repository");
		expect(readdirSync(path.join(root, ".workpilot", "specs"))).toEqual([]);
	});

	it("joins the card still waiting for review, then opens a new one once its PR exists", async () => {
		const first = await openReviewWorkspace(project, { source: "test-studio", subject: "A" }, deps);
		await recordReviewStep(first, { message: "test: a", summary: "Tests A" }, deps);

		const second = await openReviewWorkspace(project, { source: "test-studio", subject: "B" }, deps);
		expect(second.reused).toBe(true);
		expect(second.specId).toBe(first.specId);

		// Another page never joins it.
		const design = await openReviewWorkspace(project, { source: "design-import", subject: "Écran" }, deps);
		expect(design.specId).not.toBe(first.specId);

		// The PR is opened: the card leaves human review.
		const planPath = path.join(root, ".workpilot", "specs", first.specId, "implementation_plan.json");
		writeFileSync(
			planPath,
			JSON.stringify({ ...JSON.parse(readFileSync(planPath, "utf-8")), status: "pr_created" }),
			"utf-8",
		);
		const third = await openReviewWorkspace(project, { source: "test-studio", subject: "C" }, deps);
		expect(third.reused).toBe(false);
		expect(third.specId).not.toBe(first.specId);
	});
});

describe("recordReviewStep", () => {
	it("commits and puts the card in human review with the run as a done subtask", async () => {
		const ws = await openReviewWorkspace(project, { source: "test-studio", subject: "A" }, deps);

		const review = await recordReviewStep(
			ws,
			{ message: "test: add generated unit tests for A", summary: "Tests unitaires de A" },
			deps,
		);

		expect(calls[1]).toEqual([
			"--action",
			"commit",
			"--project-dir",
			root,
			"--spec",
			ws.specId,
			"--message",
			"test: add generated unit tests for A",
			"--base-branch",
			"develop",
		]);
		expect(review).toMatchObject({
			taskId: ws.specId,
			branch: `workpilot/${ws.specId}`,
			baseBranch: "develop",
			files: ["tests/test_a.py"],
			committed: true,
		});
		const plan = readSpec(ws.specId, "implementation_plan.json");
		expect(plan).toMatchObject({
			status: "human_review",
			reviewReason: "completed",
			xstateState: "human_review",
		});
		expect(plan.phases[0].subtasks).toEqual([
			{
				id: "generated-1",
				description: "Tests unitaires de A",
				status: "completed",
				files_changed: ["tests/test_a.py"],
			},
		]);
		expect(findOpenReviewCard(project, "test-studio")?.specId).toBe(ws.specId);
	});

	it("writes each run into the card's log, which no pipeline writes for it", async () => {
		const ws = await openReviewWorkspace(project, { source: "test-studio", subject: "A" }, deps);
		await recordReviewStep(
			ws,
			{
				message: "test: add generated unit tests for A",
				summary: "Tests unitaires de A",
				log: ["detect (done): Python · pytest", "write (done): tests/test_a.py"],
			},
			deps,
		);
		commitAnswer = { committed: true, files: ["requirements-dev.txt"] };
		const next = await openReviewWorkspace(project, { source: "test-studio", subject: "B" }, deps);
		await recordReviewStep(next, { message: "test: add test packages B", summary: "Paquets B" }, deps);

		const logs = readSpec(ws.specId, "task_logs.json");
		expect(logs.spec_id).toBe(ws.specId);
		expect(logs.phases.coding.status).toBe("completed");
		expect(logs.phases.coding.entries.map((e: { type: string; content: string }) => [e.type, e.content])).toEqual([
			["phase_start", "Tests unitaires de A"],
			["text", "detect (done): Python · pytest"],
			["text", "write (done): tests/test_a.py"],
			["info", "Écrit tests/test_a.py"],
			["success", "Commit : test: add generated unit tests for A"],
			["phase_end", "Tests unitaires de A"],
			["phase_start", "Paquets B"],
			["info", "Écrit requirements-dev.txt"],
			["success", "Commit : test: add test packages B"],
			["phase_end", "Paquets B"],
		]);
	});

	it("leaves no log behind for a run that wrote nothing", async () => {
		commitAnswer = { committed: false, files: [] };
		const ws = await openReviewWorkspace(project, { source: "test-studio", subject: "A" }, deps);
		await recordReviewStep(ws, { message: "test: a", summary: "A", log: ["x"] }, deps);
		expect(existsSync(path.join(root, ".workpilot", "specs", ws.specId, "task_logs.json"))).toBe(false);
	});

	it("counts the commits the run's own agent made since it began", async () => {
		const run = deps.run;
		deps = {
			...deps,
			run: async (args) => {
				const out = await run(args);
				return args.includes("create") ? { ...out, head: "abc123" } : out;
			},
		};
		const ws = await openReviewWorkspace(project, { source: "pair-programming", subject: "A" }, deps);
		expect(ws.startHead).toBe("abc123");

		await recordReviewStep(ws, { message: "feat: a", summary: "s" }, deps);

		expect(calls[1].slice(-2)).toEqual(["--since", "abc123"]);
	});

	it("takes back a new card the run wrote nothing to", async () => {
		const ws = await openReviewWorkspace(project, { source: "test-studio", subject: "A" }, deps);
		commitAnswer = { committed: false, files: [] };

		const review = await recordReviewStep(ws, { message: "m", summary: "s" }, deps);

		expect(review.committed).toBe(false);
		expect(deps.cleanup).toHaveBeenCalledWith(
			expect.objectContaining({ specId: ws.specId, deleteBranch: true }),
		);
		expect(existsSync(path.join(root, ".workpilot", "specs", ws.specId))).toBe(false);
	});

	it("keeps a joined card when a later run writes nothing", async () => {
		const first = await openReviewWorkspace(project, { source: "test-studio", subject: "A" }, deps);
		await recordReviewStep(first, { message: "m", summary: "s" }, deps);
		const again = await openReviewWorkspace(project, { source: "test-studio", subject: "B" }, deps);
		commitAnswer = { committed: false, files: [] };

		await recordReviewStep(again, { message: "m", summary: "s" }, deps);

		expect(deps.cleanup).not.toHaveBeenCalled();
		expect(readSpec(first.specId, "implementation_plan.json").phases[0].subtasks).toHaveLength(1);
	});
});

describe("toWorkspacePath", () => {
	// Absolute on every platform: "\\repo" alone has no drive on Windows.
	const project = path.resolve(path.sep, "repo");
	const worktree = path.join(project, ".workpilot", "worktrees", "tasks", "001-a");

	it("moves a project path to the same place in the worktree", () => {
		expect(toWorkspacePath(project, worktree, path.join(project, "src", "a.ts"))).toBe(
			path.join(worktree, "src", "a.ts"),
		);
	});

	it("keeps relative paths and paths already in the worktree", () => {
		expect(toWorkspacePath(project, worktree, path.join("tests", "unit"))).toBe(
			path.join("tests", "unit"),
		);
		expect(toWorkspacePath(project, worktree, path.join(worktree, "x.ts"))).toBe(
			path.join(worktree, "x.ts"),
		);
	});

	it("has no counterpart for what is outside the project or in its WorkPilot folder", () => {
		expect(toWorkspacePath(project, worktree, path.resolve(path.sep, "etc", "passwd"))).toBeUndefined();
		expect(toWorkspacePath(project, worktree, path.join("..", "..", "x"))).toBeUndefined();
		expect(
			toWorkspacePath(project, worktree, path.join(project, ".workpilot", "specs", "x")),
		).toBeUndefined();
		expect(toWorkspacePath(project, worktree, undefined)).toBeUndefined();
	});
});
