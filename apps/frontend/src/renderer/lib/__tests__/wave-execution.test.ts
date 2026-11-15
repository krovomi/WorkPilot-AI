/**
 * "Execute in optimal order": what starts now, and when the next wave begins.
 */
import { describe, expect, it } from "vitest";
import type { Task, TaskStatus } from "../../../shared/types";
import { stepWaveExecution, type WaveExecution } from "../wave-execution";

function task(id: string, status: TaskStatus, metadata: Task["metadata"] = {}, projectId = "p1"): Task {
	return { id, specId: id, projectId, title: id, description: "", status, subtasks: [], logs: [], metadata } as unknown as Task;
}

function run(extra: Partial<WaveExecution> = {}): WaveExecution {
	return {
		projectId: "p1",
		waves: [["a", "b", "c"], ["d"]],
		current: 0,
		advanceWhen: "merged",
		maxParallel: 3,
		status: "running",
		started: [],
		...extra,
	};
}

describe("stepWaveExecution", () => {
	it.each([
		{
			name: "starts the wave up to the max parallelism",
			tasks: [task("a", "backlog"), task("b", "backlog"), task("c", "queue"), task("d", "backlog")],
			max: 2,
			promote: ["a", "b"],
		},
		{
			name: "counts tasks already running outside the plan",
			tasks: [task("a", "backlog"), task("b", "backlog"), task("c", "backlog"), task("x", "in_progress")],
			max: 2,
			promote: ["a"],
		},
		{
			name: "never starts the next wave early",
			tasks: [task("a", "in_progress"), task("b", "done"), task("c", "done"), task("d", "backlog")],
			max: 3,
			promote: [],
		},
		{
			name: "never starts a task twice",
			tasks: [task("a", "backlog"), task("b", "backlog"), task("c", "backlog")],
			max: 3,
			started: ["a"],
			promote: ["b", "c"],
		},
	])("$name", ({ tasks, max, started, promote }) => {
		const step = stepWaveExecution(run({ started: started ?? [], maxParallel: max }), tasks);
		expect(step.promote).toEqual(promote);
		expect(step.waveSettled).toBe(false);
	});

	it("holds back a task whose dependency is not finished", () => {
		const step = stepWaveExecution(
			run({ waves: [["a", "b"]] }),
			[task("a", "backlog", { blockedBy: ["z"] }), task("b", "backlog"), task("z", "human_review")]
		);
		expect(step.promote).toEqual(["b"]);
		expect(step.blocked).toEqual(["a"]);
	});

	it.each([
		["merged", ["done", "done", "done"], true],
		["merged", ["done", "human_review", "done"], false],
		["review", ["done", "human_review", "pr_created"], true],
		["review", ["error", "human_review", "ai_review"], false],
	] as const)("with advance %s, statuses %j settle the wave: %s", (advanceWhen, statuses, settled) => {
		const tasks = statuses.map((status, i) => task(["a", "b", "c"][i], status));
		const step = stepWaveExecution(run({ advanceWhen }), [...tasks, task("d", "backlog")]);
		expect(step.waveSettled).toBe(settled);
		expect(step.finished).toBe(false);
	});

	it("does not wait on a started task put back in the backlog, nor on an archived one", () => {
		const step = stepWaveExecution(
			run({ started: ["a"] }),
			[task("a", "backlog"), task("b", "done"), task("c", "backlog", { archivedAt: "2026-11-01" } as Task["metadata"])]
		);
		expect(step.waveSettled).toBe(true);
	});

	it("finishes after the last wave", () => {
		const step = stepWaveExecution(run({ current: 1 }), [task("d", "done")]);
		expect(step).toMatchObject({ waveSettled: true, finished: true });
	});

	it("finishes when a re-plan left no wave to run", () => {
		const step = stepWaveExecution(run({ waves: [["a"]], current: 1 }), [task("a", "done")]);
		expect(step).toMatchObject({ waveSettled: true, finished: true });
	});

	it("waits while the board shows another project", () => {
		const step = stepWaveExecution(run(), [task("a", "backlog", {}, "p2")]);
		expect(step).toEqual({ promote: [], blocked: [], waveSettled: false, finished: false });
	});

	it("does nothing once stopped", () => {
		const step = stepWaveExecution(run({ status: "stopped" }), [task("a", "backlog")]);
		expect(step.promote).toEqual([]);
	});
});
