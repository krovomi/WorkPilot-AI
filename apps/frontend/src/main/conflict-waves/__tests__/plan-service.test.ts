/**
 * The renderer names a project and tasks by id: everything else is refused,
 * and the max parallelism comes from the project, never from the request.
 */
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../../shared/types/project";
import type { Task } from "../../../shared/types/task";
import {
	buildExecutionWavePlan,
	MAX_PLAN_TASKS,
	maxParallelOf,
	validateWavePlanRequest,
	type WavePlanDeps,
} from "../plan-service";

const PROJECT_ID = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

function makeTask(id: string, status: Task["status"], files: string[], extra: Partial<Task> = {}): Task {
	return {
		id,
		specId: id,
		projectId: PROJECT_ID,
		title: `Task ${id}`,
		description: "",
		status,
		subtasks: [{ id: "1", title: "s", description: "", status: "pending", files }],
		logs: [],
		createdAt: new Date("2026-11-01T10:00:00Z"),
		updatedAt: new Date("2026-11-01T10:00:00Z"),
		...extra,
	} as Task;
}

function makeDeps(tasks: Task[], settings: Partial<Project["settings"]> = { maxParallelTasks: 2 }): WavePlanDeps {
	const project = { id: PROJECT_ID, path: "/projects/shop", settings } as unknown as Project;
	return {
		getProject: (id) => (id === PROJECT_ID ? project : undefined),
		getTasks: () => tasks,
		readWorktreeFiles: vi.fn(async (_path: string, specId: string) =>
			specId === "002-running" ? ["src/cart.rs", "src/extra1.rs", "src/extra2.rs", "src/extra3.rs"] : null,
		),
		now: () => new Date("2026-11-14T08:00:00Z"),
	};
}

describe("validateWavePlanRequest refuses hostile input", () => {
	it.each([
		["not an object", "nope"],
		["an array", [PROJECT_ID]],
		["no project", {}],
		["a path as project", { projectId: "/etc/passwd" }],
		["a traversal as project", { projectId: "../other" }],
		["a non-string project", { projectId: 42 }],
		["a path as task id", { projectId: PROJECT_ID, taskIds: ["../../etc"] }],
		["a slash in a task id", { projectId: PROJECT_ID, taskIds: ["001/x"] }],
		["a non-string task id", { projectId: PROJECT_ID, taskIds: [{ id: "x" }] }],
		["task ids not in a list", { projectId: PROJECT_ID, taskIds: "001-a" }],
		[
			"too many task ids",
			{ projectId: PROJECT_ID, taskIds: Array.from({ length: MAX_PLAN_TASKS + 1 }, (_, i) => `t${i}`) },
		],
		["a negative tolerance", { projectId: PROJECT_ID, options: { tolerance: -1 } }],
		["an infinite tolerance", { projectId: PROJECT_ID, options: { tolerance: Number.POSITIVE_INFINITY } }],
		["a string tolerance", { projectId: PROJECT_ID, options: { tolerance: "0" } }],
		["an unknown policy", { projectId: PROJECT_ID, options: { unplannedPolicy: "yolo" } }],
		["a huge drift threshold", { projectId: PROJECT_ID, options: { driftThreshold: 1e9 } }],
		["options not an object", { projectId: PROJECT_ID, options: ["x"] }],
	])("refuses %s", (_name, raw) => {
		expect(validateWavePlanRequest(raw).ok).toBe(false);
	});

	it("accepts an accented spec id and drops duplicates", () => {
		const result = validateWavePlanRequest({
			projectId: PROJECT_ID,
			taskIds: ["002-numéro-de-commande", "002-numéro-de-commande"],
		});
		expect(result).toEqual({
			ok: true,
			value: {
				projectId: PROJECT_ID,
				taskIds: ["002-numéro-de-commande"],
				tolerance: 0,
				unplannedPolicy: "isolate",
				driftThreshold: 3,
			},
		});
	});

	it("keeps explicit options in range", () => {
		const result = validateWavePlanRequest({
			projectId: PROJECT_ID,
			options: { tolerance: 2, driftThreshold: 0, unplannedPolicy: "independent" },
		});
		expect(result.ok && result.value).toMatchObject({
			tolerance: 2,
			driftThreshold: 0,
			unplannedPolicy: "independent",
		});
	});

	it("ignores a max parallelism sent by the renderer", () => {
		const result = validateWavePlanRequest({ projectId: PROJECT_ID, options: { maxParallel: 99 } });
		expect(result.ok && "maxParallel" in result.value).toBe(false);
	});
});

describe("buildExecutionWavePlan", () => {
	const tasks = [
		makeTask("001-a", "backlog", ["src/cart.rs"]),
		makeTask("003-b", "queue", ["src/cart.rs"]),
		makeTask("004-c", "backlog", ["docs/readme.md"]),
		makeTask("002-running", "in_progress", ["src/cart.rs"]),
		makeTask("005-done", "done", ["src/cart.rs"]),
		makeTask("006-archived", "backlog", ["x"], { metadata: { archivedAt: "2026-11-01" } } as Partial<Task>),
	];

	it("plans the backlog and queue of the project with its own max parallelism", async () => {
		const result = await buildExecutionWavePlan({ projectId: PROJECT_ID }, makeDeps(tasks));
		if (!result.ok) throw new Error(result.error);
		const plan = result.value;
		expect(plan.maxParallel).toBe(2);
		expect(plan.waves.map((w) => w.taskIds.length)).toEqual([2, 1]);
		expect(plan.order.sort()).toEqual(["001-a", "003-b", "004-c"]);
		expect(plan.drift).toEqual([
			expect.objectContaining({ taskId: "002-running", extraCount: 3 }),
		]);
		expect(plan.runningConflicts.map((c) => c.runningTaskId)).toEqual(["002-running", "002-running"]);
		expect(plan.computedAt).toBe("2026-11-14T08:00:00.000Z");
	});

	it("reads worktrees from the project's own path, never one from the request", async () => {
		const deps = makeDeps(tasks);
		await buildExecutionWavePlan({ projectId: PROJECT_ID, projectPath: "/tmp/evil" }, deps);
		for (const call of (deps.readWorktreeFiles as ReturnType<typeof vi.fn>).mock.calls) {
			expect(call[0]).toBe("/projects/shop");
		}
	});

	it("refuses an unknown project", async () => {
		const result = await buildExecutionWavePlan({ projectId: "0000" }, makeDeps(tasks));
		expect(result).toEqual({ ok: false, error: "Project not found" });
	});

	it("refuses a task of another project or one already running", async () => {
		const deps = makeDeps(tasks);
		expect((await buildExecutionWavePlan({ projectId: PROJECT_ID, taskIds: ["999-x"] }, deps)).ok).toBe(false);
		expect(
			(await buildExecutionWavePlan({ projectId: PROJECT_ID, taskIds: ["002-running"] }, deps)).ok,
		).toBe(false);
		expect(
			(await buildExecutionWavePlan({ projectId: PROJECT_ID, taskIds: ["006-archived"] }, deps)).ok,
		).toBe(false);
	});

	it("orders by priority and age, reads blockers, and tolerates odd metadata", async () => {
		const odd = [
			makeTask("010-low", "backlog", ["x"], { metadata: { priority: "low" } } as Partial<Task>),
			makeTask("011-urgent", "backlog", ["x"], { metadata: { priority: "urgent" } } as Partial<Task>),
			makeTask("012-bad-date", "backlog", ["x"], { createdAt: "not a date" as unknown as Date, metadata: undefined }),
			makeTask("013-after", "backlog", ["y"], {
				metadata: { blockedBy: [42, "011-urgent"] },
			} as unknown as Partial<Task>),
			makeTask("014-weird", "backlog", ["x"], { metadata: { priority: "mega" } } as unknown as Partial<Task>),
		];
		const result = await buildExecutionWavePlan({ projectId: PROJECT_ID }, makeDeps(odd, { maxParallelTasks: 5 }));
		if (!result.ok) throw new Error(result.error);
		// All but one share `x`: one per wave, the most urgent first, then by
		// age (the unreadable date counts as the oldest); the blocked one goes
		// after its blocker, the first wave where it fits.
		expect(result.value.waves.map((w) => w.taskIds)).toEqual([
			["011-urgent"],
			["010-low", "013-after"],
			["012-bad-date"],
			["014-weird"],
		]);
	});

	it("plans only the tasks named", async () => {
		const result = await buildExecutionWavePlan(
			{ projectId: PROJECT_ID, taskIds: ["004-c", "001-a"] },
			makeDeps(tasks),
		);
		expect(result.ok && result.value.waves.map((w) => w.taskIds.sort())).toEqual([["001-a", "004-c"]]);
	});

	it.each([
		[undefined, 3],
		[0, 1],
		[5, 5],
		[1000, 32],
		[Number.NaN, 3],
	])("max parallel tasks %s gives waves of %d", (value, expected) => {
		const project = { settings: { maxParallelTasks: value } } as unknown as Project;
		expect(maxParallelOf(project)).toBe(expected);
	});
});
