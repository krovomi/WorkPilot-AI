/**
 * The runs the team server stopped (restarted) while they were queued or
 * running, as `GET /users/me/interrupted-runs` lists them
 * (apps/backend/server/services/interrupted_runs.py).
 */

/** Where the run stopped, as the desktop's launch dialog names it. */
export type InterruptedPhase = "spec" | "planning" | "coding" | "qa_review";

export interface InterruptedRun {
	run_id: string;
	/** The card's index id, which its run routes take. */
	spec_id: string;
	/** The card's folder name, which the card screen takes. */
	card_id: string;
	project_id: string;
	project_name: string;
	title: string;
	run_phase: string;
	phase: InterruptedPhase;
	subtasks_done: number;
	subtasks_total: number;
	next_subtask: string | null;
	model: string | null;
	interrupted_at: string | null;
	/** Started by the person signed in; otherwise a project owner sees a teammate's. */
	mine: boolean;
	started_by_name: string | null;
	blocker: "spec_missing" | null;
}

/** Ticked when the prompt opens: one's own run, nothing in the way. */
export function selectedByDefault(run: InterruptedRun): boolean {
	return run.mine && run.blocker === null;
}

export const STEPS = ["spec", "planning", "coding", "qa"] as const;
export type Step = (typeof STEPS)[number];

export function stepOf(run: InterruptedRun): Step {
	return run.phase === "qa_review" ? "qa" : run.phase;
}
