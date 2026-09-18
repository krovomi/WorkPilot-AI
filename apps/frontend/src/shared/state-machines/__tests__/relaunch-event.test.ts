import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import type { Task } from "../../types";
import { relaunchEventFor } from "../task-state-utils";
import { type TaskEvent, taskMachine } from "../task-machine";

/**
 * What a resume owes the state machine.
 *
 * Resuming a task used to tell the machine nothing, which left it settled in
 * the state the previous run failed in — the red failure banner stayed above a
 * task that was visibly running again, quoting the run it replaced.
 */

type RelaunchTask = Parameters<typeof relaunchEventFor>[1];

function task(overrides: Partial<Task> = {}): RelaunchTask {
	return {
		status: "human_review",
		subtasks: [],
		...overrides,
	} as RelaunchTask;
}

describe("relaunchEventFor", () => {
	it("resumes a failed task that already has a plan", () => {
		expect(
			relaunchEventFor("error", task({ subtasks: [{ id: "s1" }] as Task["subtasks"] })),
		).toEqual({ type: "USER_RESUMED" });
	});

	it("re-plans a failed task that never got one", () => {
		expect(relaunchEventFor("error", task())).toEqual({
			type: "PLANNING_STARTED",
		});
	});

	it("re-plans when the pause caught the task before coding", () => {
		// A task paused during planning has subtasks from an earlier run, so the
		// subtask count alone would send it to `coding` — where the planning it
		// is about to redo would be reported to nobody.
		const paused = task({
			subtasks: [{ id: "s1" }] as Task["subtasks"],
			metadata: { paused: { paused_phase: "planning" } },
		} as Partial<Task>);
		expect(relaunchEventFor("human_review", paused)).toEqual({
			type: "PLANNING_STARTED",
		});
	});

	it("owes nothing to a task paused mid-run", () => {
		// `coding` is already where the resumed run belongs.
		expect(relaunchEventFor("coding", task({ status: "in_progress" }))).toBeNull();
		expect(relaunchEventFor("qa_review", task({ status: "ai_review" }))).toBeNull();
	});

	it("falls back to the task's own status when no actor exists yet", () => {
		expect(relaunchEventFor(undefined, task({ status: "error" }))).toEqual({
			type: "PLANNING_STARTED",
		});
		expect(relaunchEventFor(undefined, task({ status: "backlog" }))).toBeNull();
	});

	it("clears the failure message the banner renders", () => {
		// The point of the whole exercise: the event has to be one the settled
		// state actually handles, and it has to clear the context the banner
		// reads. Asserted against the real machine rather than the table above.
		for (const state of ["error", "human_review"]) {
			const actor = createActor(taskMachine, {
				snapshot: taskMachine.resolveState({
					value: state,
					context: { reviewReason: "errors", error: "planner produced no plan" },
				}),
			});
			actor.start();
			const event = relaunchEventFor(state, task({ subtasks: [{ id: "s1" }] as Task["subtasks"] }));
			actor.send(event as TaskEvent);

			expect(String(actor.getSnapshot().value)).not.toBe(state);
			expect(actor.getSnapshot().context.error).toBeUndefined();
			expect(actor.getSnapshot().context.reviewReason).toBeUndefined();
		}
	});
});
