/**
 * @vitest-environment node
 *
 * How the main process writes a task's state into its plan and metadata, on
 * real files: the status the backend understands for each column, a minimal
 * plan (never an empty `phases`, which the planner refuses) when none exists
 * yet, the error message cleared with the state it explained, updates to one
 * plan serialised, and a missing file reported, not created, where creating
 * one would be wrong.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ invalidate: vi.fn() }));
vi.mock("../../../project-store", () => ({ projectStore: { invalidateTasksCache: state.invalidate } }));

import type { Task } from "../../../../shared/types";
import {
	addChangeRequestSubtaskToPlan,
	buildChangeRequestSubtask,
	createPlanIfNotExists,
	getPlanPath,
	mapStatusToPlanStatus,
	persistPlanLastEventSync,
	persistPlanPhaseSync,
	persistPlanStatus,
	persistPlanStatusAndReasonSync,
	persistPlanStatusSync,
	updatePlanFile,
	updatePlanSubtasks,
	updateTaskMetadataField,
	updateTaskMetadataPrUrl,
	updateTaskMetadataVisualProof,
} from "../plan-file-utils";

let base = "";
let plan = "";
beforeEach(() => {
	base = mkdtempSync(path.join(tmpdir(), "plan-persist-"));
	plan = path.join(base, "spec", "implementation_plan.json");
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(base, { recursive: true, force: true });
});

const read = (file: string) => JSON.parse(readFileSync(file, "utf-8"));
function seed(data: object = { feature: "F", phases: [{ subtasks: [] }] }): void {
	mkdirSync(path.dirname(plan), { recursive: true });
	writeFileSync(plan, JSON.stringify(data), "utf-8");
}
/** A folder where the plan should be: reading it fails, and not with ENOENT. */
function blockPlan(): void {
	mkdirSync(plan, { recursive: true });
}

describe("plan paths and statuses", () => {
	it("finds the plan in the project's spec folder", () => {
		const task = { specId: "001-x" } as Task;
		expect(getPlanPath({ path: base, autoBuildPath: ".wp" } as never, task)).toBe(
			path.join(base, ".wp", "specs", "001-x", "implementation_plan.json"),
		);
		expect(getPlanPath({ path: base } as never, task)).toBe(
			path.join(base, ".workpilot", "specs", "001-x", "implementation_plan.json"),
		);
	});

	it("maps every column to the status the backend reads", () => {
		expect(
			(["queue", "in_progress", "ai_review", "human_review", "build_failed", "done", "backlog", "error"] as const).map(
				mapStatusToPlanStatus,
			),
		).toEqual(["queued", "in_progress", "review", "review", "review", "completed", "pending", "pending"]);
	});
});

describe("persistPlanStatus and persistPlanStatusSync", () => {
	it("writes the status into an existing plan and refreshes the board", async () => {
		seed();
		expect(await persistPlanStatus(plan, "queue", "p1")).toBe(true);
		expect(read(plan)).toMatchObject({ feature: "F", status: "queue", planStatus: "queued" });
		expect(persistPlanStatusSync(plan, "done", "p1")).toBe(true);
		expect(read(plan)).toMatchObject({ status: "done", planStatus: "completed" });
		expect(state.invalidate).toHaveBeenCalledTimes(2);
		expect(persistPlanStatusSync(plan, "done")).toBe(true);
		expect(await persistPlanStatus(plan, "done")).toBe(true);
		expect(state.invalidate).toHaveBeenCalledTimes(2);
	});

	it("answers false for a missing or unreadable plan, without creating one", async () => {
		expect(await persistPlanStatus(plan, "done")).toBe(false);
		expect(persistPlanStatusSync(plan, "done")).toBe(false);
		expect(existsSync(plan)).toBe(false);
		blockPlan();
		expect(await persistPlanStatus(plan, "done")).toBe(false);
		expect(persistPlanStatusSync(plan, "done")).toBe(false);
	});

	it("serialises updates to one plan, in the order they were asked", async () => {
		seed({ phases: [] });
		const order: string[] = [];
		await Promise.all([
			updatePlanFile<Record<string, unknown>>(plan, (p) => {
				order.push("first");
				return { ...p, a: 1 };
			}),
			persistPlanStatus(plan, "in_progress"),
			updatePlanFile<Record<string, unknown>>(plan, (p) => {
				order.push("third");
				return { ...p, c: 3 };
			}),
		]);
		expect(order).toEqual(["first", "third"]);
		expect(read(plan)).toMatchObject({ a: 1, c: 3, status: "in_progress" });
	});
});

describe("persistPlanLastEventSync", () => {
	it("records the last event, and leaves a missing plan missing", () => {
		const event = { eventId: "e1", sequence: 4, type: "CODING_STARTED", timestamp: "t", extra: "dropped" };
		expect(persistPlanLastEventSync(plan, event as never)).toBe(false);
		seed();
		expect(persistPlanLastEventSync(plan, event as never)).toBe(true);
		expect(read(plan).lastEvent).toEqual({ eventId: "e1", sequence: 4, type: "CODING_STARTED", timestamp: "t" });
		rmSync(plan);
		blockPlan();
		expect(persistPlanLastEventSync(plan, event as never)).toBe(false);
	});
});

describe("persistPlanStatusAndReasonSync", () => {
	it("creates a minimal plan without phases when there is none", () => {
		expect(
			persistPlanStatusAndReasonSync(plan, "human_review", "errors", "p1", "error", "coding", "Build failed"),
		).toBe(true);
		const written = read(plan);
		expect(written).toMatchObject({
			status: "human_review",
			planStatus: "review",
			reviewReason: "errors",
			xstateState: "error",
			executionPhase: "coding",
			errorMessage: "Build failed",
		});
		expect(written.phases).toBeUndefined();
		expect(state.invalidate).toHaveBeenCalledWith("p1");
	});

	it("clears the error message once the task leaves the error state", () => {
		seed({ phases: [], errorMessage: "old", xstateState: "error", executionPhase: "coding" });
		expect(persistPlanStatusAndReasonSync(plan, "in_progress")).toBe(true);
		const written = read(plan);
		expect(written.errorMessage).toBeUndefined();
		expect(written.reviewReason).toBeUndefined();
		// Without new values, the machine state and phase are kept.
		expect(written).toMatchObject({ xstateState: "error", executionPhase: "coding" });
		expect(state.invalidate).not.toHaveBeenCalled();
	});

	it("answers false for an unreadable plan", () => {
		blockPlan();
		expect(persistPlanStatusAndReasonSync(plan, "done")).toBe(false);
	});
});

describe("persistPlanPhaseSync", () => {
	it("moves the card to the column of the phase, creating a minimal plan if needed", () => {
		const cases: Array<[string, string | undefined]> = [
			["planning", "in_progress"],
			["coding", "in_progress"],
			["qa_review", "ai_review"],
			["qa_fixing", "ai_review"],
			["complete", "human_review"],
			["failed", "error"],
		];
		for (const [phase, status] of cases) {
			expect(persistPlanPhaseSync(plan, phase, "p1")).toBe(true);
			expect(read(plan)).toMatchObject({ executionPhase: phase, status });
		}
		expect(read(plan).phases).toBeUndefined();

		// An unknown phase is recorded without moving the card.
		expect(persistPlanPhaseSync(plan, "idle")).toBe(true);
		expect(read(plan)).toMatchObject({ executionPhase: "idle", status: "error" });
	});

	it("answers false for an unreadable plan", () => {
		blockPlan();
		expect(persistPlanPhaseSync(plan, "coding")).toBe(false);
	});
});

describe("updatePlanFile and updatePlanSubtasks", () => {
	it("updates an existing plan, and answers null for a missing or broken one", async () => {
		expect(await updatePlanFile(plan, (p) => p)).toBeNull();
		seed();
		const updated = await updatePlanFile<Record<string, unknown>>(plan, (p) => ({ ...p, x: 1 }));
		expect(updated).toMatchObject({ x: 1 });
		expect(typeof updated?.updated_at).toBe("string");
		writeFileSync(plan, "{ broken", "utf-8");
		expect(await updatePlanFile(plan, (p) => p)).toBeNull();
	});

	it("merges the edits into the plan's phases and refreshes the board only after a write", async () => {
		expect(await updatePlanSubtasks(plan, [], "p1")).toBeNull();
		expect(state.invalidate).not.toHaveBeenCalled();
		seed();
		const edits = [{ id: "a", description: "Do A" }];
		const phases = [{ subtasks: [{ id: "a", description: "Do A", status: "pending", files_to_modify: [] }] }];
		expect(await updatePlanSubtasks(plan, edits, "p1")).toMatchObject({ feature: "F", phases });
		expect(state.invalidate).toHaveBeenCalledWith("p1");
		expect(await updatePlanSubtasks(plan, edits)).toMatchObject({ phases });
		expect(state.invalidate).toHaveBeenCalledTimes(1);
	});
});

describe("createPlanIfNotExists", () => {
	const task = { title: "T", description: "", createdAt: new Date("2026-11-01T00:00:00Z") } as Task;

	it("creates a plan with its folder, keeps one that exists, and stops on an unreadable path", async () => {
		await createPlanIfNotExists(plan, task, "queue", "queued");
		expect(read(plan)).toMatchObject({
			feature: "T",
			description: "",
			created_at: "2026-11-01T00:00:00.000Z",
			status: "queue",
			planStatus: "queued",
			xstateState: "queued",
			phases: [],
		});
		writeFileSync(plan, JSON.stringify({ kept: true }), "utf-8");
		await createPlanIfNotExists(plan, task, "done");
		expect(read(plan)).toEqual({ kept: true });

		rmSync(plan);
		blockPlan();
		await expect(createPlanIfNotExists(plan, task, "done")).rejects.toThrow();
	});

	it("fails when its folder cannot be created", async () => {
		writeFileSync(path.join(base, "spec"), "a file", "utf-8");
		await expect(createPlanIfNotExists(plan, { ...task, description: "d" } as Task, "done")).rejects.toThrow();
	});
});

describe("task metadata", () => {
	const meta = () => path.join(base, "spec", "task_metadata.json");

	it("adds the PR address, creating the file and its folder", () => {
		expect(updateTaskMetadataPrUrl(meta(), "https://example.invalid/pr/1")).toBe(true);
		expect(read(meta())).toEqual({ prUrl: "https://example.invalid/pr/1" });
		writeFileSync(meta(), JSON.stringify({ provider: "ollama" }), "utf-8");
		expect(updateTaskMetadataPrUrl(meta(), "https://example.invalid/pr/2")).toBe(true);
		expect(read(meta())).toEqual({ provider: "ollama", prUrl: "https://example.invalid/pr/2" });
	});

	it("sets one field, keeping the others", () => {
		writeFileSync(path.join(base, "keep.json"), JSON.stringify({ a: 1 }), "utf-8");
		expect(updateTaskMetadataField(path.join(base, "keep.json"), "cicdRun", { id: 3 })).toBe(true);
		expect(read(path.join(base, "keep.json"))).toEqual({ a: 1, cicdRun: { id: 3 } });
		expect(updateTaskMetadataVisualProof(meta(), { status: "passed" } as never)).toBe(true);
		expect(read(meta())).toEqual({ visualProof: { status: "passed" } });
	});

	it("answers false for a file it cannot read", () => {
		mkdirSync(meta(), { recursive: true });
		expect(updateTaskMetadataPrUrl(meta(), "x")).toBe(false);
		expect(updateTaskMetadataField(meta(), "cicdRun", 1)).toBe(false);
	});
});

describe("addChangeRequestSubtaskToPlan", () => {
	it("adds the subtask to the Implementation phase, creating what is missing", () => {
		const subtask = buildChangeRequestSubtask("x");
		seed({});
		expect(addChangeRequestSubtaskToPlan(plan, subtask)).toBe(true);
		expect(read(plan).phases).toEqual([{ name: "Implementation", subtasks: [subtask] }]);
		seed({ phases: [{ name: "Implementation" }] });
		expect(addChangeRequestSubtaskToPlan(plan, subtask)).toBe(true);
		expect(read(plan).phases[0].subtasks).toEqual([subtask]);
		expect(addChangeRequestSubtaskToPlan(path.join(base, "missing.json"), subtask)).toBe(false);
	});
});

describe("the status history beside the plan", () => {
	const history = () =>
		JSON.parse(readFileSync(path.join(path.dirname(plan), "status_history.json"), "utf-8")).entries;

	it("records a change with who made it, only when asked", async () => {
		seed({ phases: [], status: "human_review", reviewReason: "plan_review" });
		expect(await persistPlanStatus(plan, "in_progress", "p1")).toBe(true);
		expect(existsSync(path.join(path.dirname(plan), "status_history.json"))).toBe(false);

		expect(await persistPlanStatus(plan, "ai_review", "p1", "system")).toBe(true);
		expect(
			persistPlanStatusAndReasonSync(plan, "human_review", "completed", "p1", "human_review", "complete", undefined, "agent"),
		).toBe(true);
		expect(history().map((e: { from: string; to: string; reason?: string; actor: string }) => [e.from, e.to, e.reason, e.actor])).toEqual([
			// An empty history starts from what the plan said before.
			["in_progress", "ai_review", undefined, "system"],
			["ai_review", "human_review", "completed", "agent"],
		]);
	});

	it("starts from nothing when the plan did not exist", () => {
		expect(persistPlanStatusAndReasonSync(plan, "in_progress", undefined, undefined, undefined, undefined, undefined, "user")).toBe(true);
		expect(history()).toEqual([expect.objectContaining({ from: null, to: "in_progress", actor: "user" })]);
	});

	it("records nothing for a plan that is not an object", async () => {
		seed(null as never);
		expect(await persistPlanStatus(plan, "done", "p1", "user")).toBe(false);
		expect(persistPlanStatusAndReasonSync(plan, "done", undefined, "p1", undefined, undefined, undefined, "user")).toBe(false);
		expect(existsSync(path.join(path.dirname(plan), "status_history.json"))).toBe(false);
	});
});
