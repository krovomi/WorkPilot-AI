/**
 * Pure helpers for the "Refaire une étape" (re-run a phase on demand) feature.
 *
 * Phase entry in the backend is entirely STATE-DRIVEN by implementation_plan.json
 * (there is no explicit "start at phase X" argument):
 *   - Planning runs when the plan has no subtasks        (prompts.is_first_run)
 *   - Coding   runs while any subtask is not completed    (progress.get_next_subtask)
 *   - Validation runs when subtasks are done and qa_signoff is not "approved"
 *     (qa.criteria.should_run_qa)
 *
 * So re-running a phase just means rewinding the plan to the state *before* that
 * phase and restarting the task — the backend then naturally re-enters at the
 * right phase. Re-running an earlier phase cascade-invalidates the later ones
 * (planning ⊃ coding ⊃ validation), matching the product decision.
 *
 * This module is pure (no fs / no Electron) so the cascade logic is unit-tested
 * in isolation; the IPC handler wires it to disk + restart.
 */

/** The three re-runnable execution phases, as shown in the phase log headers. */
export type RerunPhase = "planning" | "coding" | "validation";

/**
 * Phases whose logs must be cleared when re-running `phase`, ordered upstream →
 * downstream. Re-running an earlier phase discards the work of the later ones,
 * so their logs must be wiped too (otherwise the feed shows stale entries from a
 * run that no longer reflects the plan).
 */
export function downstreamLogPhases(phase: RerunPhase): RerunPhase[] {
	switch (phase) {
		case "planning":
			return ["planning", "coding", "validation"];
		case "coding":
			return ["coding", "validation"];
		case "validation":
			return ["validation"];
	}
}

/** True when re-running `phase` discards already-completed downstream work and
 * therefore warrants a confirmation prompt. Validation discards nothing. */
export function rerunDiscardsWork(phase: RerunPhase): boolean {
	return phase !== "validation";
}

interface PlanSubtask {
	status?: string;
	actual_output?: unknown;
	started_at?: unknown;
	completed_at?: unknown;
	[key: string]: unknown;
}

interface PlanPhase {
	subtasks?: PlanSubtask[];
	chunks?: PlanSubtask[];
	[key: string]: unknown;
}

type Plan = Record<string, unknown>;

/** Reset a single subtask back to "pending" so get_next_subtask picks it up. */
function resetSubtask(subtask: PlanSubtask): void {
	subtask.status = "pending";
	delete subtask.actual_output;
	delete subtask.started_at;
	delete subtask.completed_at;
}

/** Reset every subtask across all phases to "pending" (re-run coding). */
function resetAllSubtasks(plan: Plan): void {
	const phases = plan.phases;
	if (!Array.isArray(phases)) return;
	for (const phase of phases as PlanPhase[]) {
		const subtasks = phase.subtasks ?? phase.chunks;
		if (Array.isArray(subtasks)) {
			for (const st of subtasks) resetSubtask(st);
		}
	}
}

/**
 * Rewind `plan` (mutated in place and returned) so the backend re-enters at
 * `phase` on the next start. See the module docstring for the state machine.
 *
 * - validation → clear qa_signoff (subtasks stay completed) ⇒ QA re-runs
 * - coding     → reset all subtasks to pending + clear qa_signoff ⇒ code then QA
 * - planning   → drop the plan's phases (is_first_run) + clear qa_signoff
 *                ⇒ plan, then code, then QA
 */
export function buildPhaseRerunPlanUpdate(plan: Plan, phase: RerunPhase): Plan {
	// QA must re-run in every case (it is the most-downstream phase). Setting the
	// sign-off to "pending" makes is_qa_approved() false (so should_run_qa can
	// fire) without looking "rejected" (which would trigger the fixes loop).
	plan.qa_signoff = { status: "pending" };

	if (phase === "planning") {
		// Emptying phases makes is_first_run() true → the planner regenerates the
		// whole plan, which then drives fresh coding + QA.
		plan.phases = [];
	} else if (phase === "coding") {
		resetAllSubtasks(plan);
	}
	// validation: nothing else — subtasks remain completed, only qa_signoff reset.

	// Clear any cooperative-pause so the restarted backend doesn't immediately
	// re-pause, and mark the plan in-progress again.
	plan.paused = {
		enabled: false,
		paused_at: null,
		paused_subtask_id: null,
	};
	plan.status = "in_progress";
	plan.planStatus = "in_progress";
	plan.executionPhase = phase;
	plan.updated_at = new Date().toISOString();
	plan.rerunNote = `Phase "${phase}" re-run requested at ${plan.updated_at}`;

	return plan;
}
