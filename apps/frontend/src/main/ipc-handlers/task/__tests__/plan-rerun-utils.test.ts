/**
 * Tests for the "Refaire une étape" plan-rewind logic.
 *
 * Verifies each phase's cascade matches the backend's state-driven entry:
 *   planning ⊃ coding ⊃ validation.
 */

import { describe, expect, it } from "vitest";
import {
	buildPhaseRerunPlanUpdate,
	downstreamLogPhases,
	rerunDiscardsWork,
} from "../plan-rerun-utils";

function makePlan() {
	return {
		phases: [
			{
				id: "phase-1",
				subtasks: [
					{
						id: "s1",
						status: "completed",
						actual_output: "done",
						started_at: "t0",
						completed_at: "t1",
					},
					{ id: "s2", status: "blocked" },
				],
			},
		],
		qa_signoff: { status: "approved", qa_session: 3 },
		status: "done",
		planStatus: "completed",
		paused: { enabled: true, paused_at: "x", paused_subtask_id: "s1" },
	} as Record<string, unknown>;
}

describe("downstreamLogPhases", () => {
	it("cascades planning → all three, coding → coding+validation, validation → itself", () => {
		expect(downstreamLogPhases("planning")).toEqual([
			"planning",
			"coding",
			"validation",
		]);
		expect(downstreamLogPhases("coding")).toEqual(["coding", "validation"]);
		expect(downstreamLogPhases("validation")).toEqual(["validation"]);
	});
});

describe("rerunDiscardsWork", () => {
	it("is true for planning/coding, false for validation", () => {
		expect(rerunDiscardsWork("planning")).toBe(true);
		expect(rerunDiscardsWork("coding")).toBe(true);
		expect(rerunDiscardsWork("validation")).toBe(false);
	});
});

describe("buildPhaseRerunPlanUpdate", () => {
	it("validation: keeps subtasks completed, only resets qa_signoff", () => {
		const plan = makePlan();
		buildPhaseRerunPlanUpdate(plan, "validation");

		const subtasks = (plan.phases as Array<{ subtasks: Array<{ status: string }> }>)[0]
			.subtasks;
		expect(subtasks[0].status).toBe("completed"); // untouched
		expect(subtasks[1].status).toBe("blocked");
		expect(plan.qa_signoff).toEqual({ status: "pending" });
		expect(plan.status).toBe("in_progress");
		expect((plan.paused as { enabled: boolean }).enabled).toBe(false);
		expect(plan.executionPhase).toBe("validation");
	});

	it("coding: resets every subtask to pending and clears qa_signoff", () => {
		const plan = makePlan();
		buildPhaseRerunPlanUpdate(plan, "coding");

		const subtasks = (
			plan.phases as Array<{
				subtasks: Array<{
					status: string;
					actual_output?: unknown;
					started_at?: unknown;
					completed_at?: unknown;
				}>;
			}>
		)[0].subtasks;
		expect(subtasks[0].status).toBe("pending");
		expect(subtasks[0].actual_output).toBeUndefined();
		expect(subtasks[0].started_at).toBeUndefined();
		expect(subtasks[0].completed_at).toBeUndefined();
		expect(subtasks[1].status).toBe("pending");
		expect(plan.qa_signoff).toEqual({ status: "pending" });
		// phases must survive so coding has something to work on
		expect(Array.isArray(plan.phases)).toBe(true);
		expect((plan.phases as unknown[]).length).toBe(1);
	});

	it("planning: empties phases so is_first_run is true", () => {
		const plan = makePlan();
		buildPhaseRerunPlanUpdate(plan, "planning");

		expect(plan.phases).toEqual([]);
		expect(plan.qa_signoff).toEqual({ status: "pending" });
		expect(plan.executionPhase).toBe("planning");
	});

	it("supports the 'chunks' subtask alias for coding re-run", () => {
		const plan = {
			phases: [{ chunks: [{ id: "c1", status: "completed" }] }],
		} as Record<string, unknown>;
		buildPhaseRerunPlanUpdate(plan, "coding");
		const chunks = (plan.phases as Array<{ chunks: Array<{ status: string }> }>)[0]
			.chunks;
		expect(chunks[0].status).toBe("pending");
	});
});
