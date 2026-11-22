/**
 * « Build rouge » loop: what a red or green CI run does to a task.
 *
 * The service is driven through `refreshTask` (the same path as a poll) with
 * a fake provider and a real implementation_plan.json in a temp directory.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Task, TaskStatus } from "../../shared/types";

const fetchLatestRun = vi.fn();
const fetchCommitRun = vi.fn();
const tasks: Task[] = [];
const projects: Project[] = [];
const recordTaskOutcome = vi.fn();
const handleUiEvent = vi.fn();
const resetForNewRun = vi.fn();
const refreshGreenCards = vi.fn();
const rerunQaReview = vi.fn();
vi.mock("../suite-placement/base-refresh", () => ({
	refreshGreenCards: (...args: unknown[]) => refreshGreenCards(...args),
}));
vi.mock("../suite-placement/qa-rerun", () => ({
	rerunQaReview: (...args: unknown[]) => rerunQaReview(...args),
}));

vi.mock("../ci-pipeline-providers", () => ({
	resolvePipelineProvider: async () => ({
		id: "github",
		label: "GitHub Actions",
		fetchLatestRun,
		fetchCommitRun,
		fetchRunErrors: async () => ["error TS2322 in src/app.ts"],
	}),
}));
vi.mock("../project-store", () => ({
	projectStore: {
		getProjects: () => projects,
		getTasks: () => tasks,
		invalidateTasksCache: vi.fn(),
	},
}));
vi.mock("../learning-loop-service", () => ({
	learningLoopService: { recordTaskOutcome },
}));
vi.mock("../project-env-file", () => ({ readProjectEnvFile: () => ({}) }));
vi.mock("../ipc-handlers/utils", () => ({ parseEnvFile: () => ({}) }));
vi.mock("../task-state-manager", () => ({
	taskStateManager: { handleUiEvent, resetForNewRun },
}));
vi.mock("../ipc-handlers/task/execution-utils", () => ({
	determineStartEvent: () => ({ type: "USER_RESUMED" }),
}));

const SPEC = "001-feature";
let root: string;
let planPath: string;
let send: ReturnType<typeof vi.fn>;
let startTaskExecution: ReturnType<typeof vi.fn>;

function writePlan(plan: Record<string, unknown>): void {
	writeFileSync(planPath, JSON.stringify(plan), "utf-8");
}

function readPlanFile(): Record<string, unknown> {
	return JSON.parse(readFileSync(planPath, "utf-8"));
}

function setTask(status: TaskStatus): void {
	tasks.length = 0;
	tasks.push({ id: "t1", specId: SPEC, status, metadata: {} } as Task);
}

function buildFixPhase(n: number) {
	return { phase: n, type: "build_fix", subtasks: [{ id: `build-fix-${n}` }] };
}

/** A fresh service instance, as after an app restart. */
async function loadService() {
	vi.resetModules();
	const mod = await import("../ci-pipeline-service");
	send = vi.fn();
	startTaskExecution = vi.fn().mockResolvedValue(undefined);
	mod.ciPipelineService.start(
		() => ({ webContents: { send } }) as never,
		{ startTaskExecution } as never,
	);
	mod.ciPipelineService.stop();
	return mod;
}

function statusChanges(): unknown[][] {
	return send.mock.calls.filter((c) => c[0] === "task:statusChange");
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
	root = mkdtempSync(path.join(tmpdir(), "ci-pipeline-"));
	const specDir = path.join(root, ".workpilot", "specs", SPEC);
	mkdirSync(specDir, { recursive: true });
	planPath = path.join(specDir, "implementation_plan.json");
	projects.length = 0;
	projects.push({
		id: "p1",
		name: "demo",
		path: root,
		autoBuildPath: ".workpilot",
		settings: {},
	} as unknown as Project);
	fetchLatestRun.mockReset();
	fetchCommitRun.mockReset();
	recordTaskOutcome.mockReset();
	handleUiEvent.mockReset();
	resetForNewRun.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});

describe("red build", () => {
	it("moves a reviewed task to « Build rouge » and starts one repair", async () => {
		setTask("human_review");
		writePlan({ status: "human_review", phases: [] });
		fetchLatestRun.mockResolvedValue({ state: "failed", runId: 101 });
		const { ciPipelineService } = await loadService();

		await ciPipelineService.refreshTask("t1");

		const plan = readPlanFile();
		expect(plan.ciHandledFailedRun).toBe("101");
		expect(plan.statusBeforeBuildFailed).toBe("human_review");
		expect(plan.phases).toHaveLength(1);
		expect(
			readFileSync(path.join(path.dirname(planPath), "BUILD_FAILURE.md"), "utf-8"),
		).toContain("error TS2322");
		expect(statusChanges().map((c) => c[2])).toEqual([
			"build_failed",
			"in_progress",
		]);
		// The repair goes through the state machine like a start from the board.
		expect(handleUiEvent).toHaveBeenCalledWith(
			"t1",
			{ type: "USER_RESUMED" },
			expect.anything(),
			expect.anything(),
		);
		expect(startTaskExecution).toHaveBeenCalledTimes(1);
	});

	it("does not handle the same red run again after a restart", async () => {
		// Repaired locally, back in review, the branch not pushed yet: the
		// latest run is still the red one already handled.
		setTask("human_review");
		writePlan({
			status: "human_review",
			ciHandledFailedRun: "101",
			phases: [buildFixPhase(1)],
		});
		fetchLatestRun.mockResolvedValue({ state: "failed", runId: 101 });
		const { ciPipelineService } = await loadService();

		await ciPipelineService.refreshTask("t1");

		expect(readPlanFile().status).toBe("human_review");
		expect(statusChanges()).toEqual([]);
		expect(recordTaskOutcome).not.toHaveBeenCalled();
		expect(startTaskExecution).not.toHaveBeenCalled();
	});

	it("only shows the badge on a done task", async () => {
		setTask("done");
		writePlan({ status: "done", phases: [] });
		fetchLatestRun.mockResolvedValue({ state: "failed", runId: 7 });
		const { ciPipelineService } = await loadService();

		await ciPipelineService.refreshTask("t1");

		const plan = readPlanFile();
		expect(plan.status).toBe("done");
		expect(plan.ciHandledFailedRun).toBe("7");
		expect(statusChanges()).toEqual([]);
		expect(startTaskExecution).not.toHaveBeenCalled();
	});

	it("stops repairing automatically after the attempt limit", async () => {
		const { MAX_AUTO_FIX_ATTEMPTS } = await import("../ci-pipeline-service");
		setTask("human_review");
		writePlan({
			status: "human_review",
			phases: Array.from({ length: MAX_AUTO_FIX_ATTEMPTS }, (_, i) =>
				buildFixPhase(i + 1),
			),
		});
		fetchLatestRun.mockResolvedValue({ state: "failed", runId: 102 });
		const { ciPipelineService } = await loadService();

		await ciPipelineService.refreshTask("t1");

		expect(readPlanFile().status).toBe("build_failed");
		expect(startTaskExecution).not.toHaveBeenCalled();
	});

	it("neither moves nor relaunches a task the agent is running", async () => {
		setTask("in_progress");
		writePlan({ status: "in_progress", phases: [] });
		fetchLatestRun.mockResolvedValue({ state: "failed", runId: 5 });
		const { ciPipelineService } = await loadService();

		await ciPipelineService.refreshTask("t1");

		const plan = readPlanFile();
		expect(plan.status).toBe("in_progress");
		expect(plan.ciHandledFailedRun).toBe("5");
		expect(statusChanges()).toEqual([]);
		expect(startTaskExecution).not.toHaveBeenCalled();
	});
});

describe("green build", () => {
	it("takes the task out of « Build rouge » to its previous status", async () => {
		setTask("build_failed");
		writePlan({
			status: "build_failed",
			statusBeforeBuildFailed: "pr_created",
			phases: [],
		});
		fetchLatestRun.mockResolvedValue({ state: "succeeded", runId: 103 });
		const { ciPipelineService } = await loadService();

		await ciPipelineService.refreshTask("t1");

		const plan = readPlanFile();
		expect(plan.status).toBe("pr_created");
		expect(plan.statusBeforeBuildFailed).toBeUndefined();
		expect(statusChanges().map((c) => c[2])).toEqual(["pr_created"]);
	});

	it("falls back to human review when the previous status is unknown", async () => {
		setTask("build_failed");
		writePlan({ status: "build_failed", phases: [] });
		fetchLatestRun.mockResolvedValue({ state: "succeeded", runId: 104 });
		const { ciPipelineService } = await loadService();

		await ciPipelineService.refreshTask("t1");

		const plan = readPlanFile();
		expect(plan.status).toBe("human_review");
		expect(plan.reviewReason).toBe("completed");
	});

	it("leaves a task outside the column alone", async () => {
		setTask("human_review");
		writePlan({ status: "human_review", phases: [] });
		fetchLatestRun.mockResolvedValue({ state: "succeeded", runId: 105 });
		const { ciPipelineService } = await loadService();

		await ciPipelineService.refreshTask("t1");

		expect(readPlanFile().status).toBe("human_review");
		expect(statusChanges()).toEqual([]);
	});
});

describe("a task's suite sent to the CI", () => {
	const SHA = "e".repeat(40);
	const suite = {
		state: "pending",
		branch: `workpilot/${SPEC}`,
		sha: SHA,
		pushedAt: "2026-11-22T10:00:00.000Z",
	};

	it("is judged on its pushed commit, not on the branch's latest run", async () => {
		setTask("human_review");
		writePlan({ status: "human_review", phases: [], ciSuite: suite });
		fetchCommitRun.mockResolvedValue({ state: "succeeded", runId: 7, webUrl: "https://ci/7" });
		const { ciPipelineService } = await loadService();

		await ciPipelineService.refreshTask("t1");

		expect(fetchCommitRun).toHaveBeenCalledWith(`workpilot/${SPEC}`, SHA);
		expect(fetchLatestRun).not.toHaveBeenCalled();
		expect(readPlanFile().ciSuite).toMatchObject({ state: "passed", webUrl: "https://ci/7" });
		expect(ciPipelineService.getStatus("t1")?.state).toBe("succeeded");
	});

	it("a red commit goes down the « Build rouge » path", async () => {
		setTask("human_review");
		writePlan({ status: "human_review", phases: [], ciSuite: suite });
		fetchCommitRun.mockResolvedValue({ state: "failed", runId: 8 });
		const { ciPipelineService } = await loadService();

		await ciPipelineService.refreshTask("t1");

		// The red path writes BUILD_FAILURE.md and starts the repair, whose
		// next approved build pushes again.
		expect(readPlanFile().ciSuite).toMatchObject({ state: "failed" });
		expect(readPlanFile().statusBeforeBuildFailed).toBe("human_review");
		expect(startTaskExecution).toHaveBeenCalledTimes(1);
	});
});

describe("after a merge", () => {
	it("refreshes the other green cards, through the CI when it is followed", async () => {
		setTask("human_review");
		refreshGreenCards.mockReset().mockResolvedValue({ [SPEC]: "ci" });
		rerunQaReview.mockReset().mockResolvedValue(true);
		const { ciPipelineService } = await loadService();

		const outcomes = await ciPipelineService.refreshAfterMerge(projects[0], "t0");

		expect(outcomes).toEqual({ [SPEC]: "ci" });
		const [project, list, merged, deps] = refreshGreenCards.mock.calls[0];
		expect([project, list, merged]).toEqual([projects[0], tasks, "t0"]);
		expect(deps.ciFollowed(projects[0])).toBe(true);
		expect(deps.baseOf(projects[0], tasks[0])).toMatch(/^[\w./-]+$/);
		await deps.rerunQa(tasks[0], projects[0]);
		expect(rerunQaReview).toHaveBeenCalledWith(tasks[0], projects[0], expect.anything(), expect.any(Function));
	});
});
