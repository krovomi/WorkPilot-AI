/**
 * Where a repo of an orchestration stands, read from its Kanban task.
 *
 * The orchestration moves to the next repo only when this one's task passed
 * QA (human review with nothing left to fix) or went further (done, PR).
 * Everything a person has to act on (plan to approve, QA rejection, errors,
 * a red CI) holds the run on that repo until the task moves again, from the
 * Kanban board, like any other task.
 */
import type {
	RepoExecutionStatus,
	ReviewReason,
	TaskStatus,
} from "../../shared/types";

export function repoStatusFromTask(
	status: TaskStatus,
	reviewReason?: ReviewReason,
): RepoExecutionStatus {
	switch (status) {
		case "backlog":
		case "queue":
			return "pending";
		case "in_progress":
			return "coding";
		case "ai_review":
			return "qa";
		case "human_review":
			if (reviewReason === "completed") return "completed";
			if (reviewReason === "stopped") return "pending";
			return "needs_you";
		case "done":
		case "pr_created":
			return "completed";
		case "build_failed":
			return "needs_you";
		case "error":
			return "failed";
		default:
			return "pending";
	}
}

/** The share of a repo's work its status stands for, for the progress bars. */
export function progressOf(status: RepoExecutionStatus, previous: number): number {
	switch (status) {
		case "pending":
			return 0;
		case "coding":
			return 50;
		case "qa":
			return 80;
		case "completed":
			return 100;
		default:
			// needs_you, failed: where it was.
			return previous;
	}
}

/** A person, not the run, has to move this repo on. */
export function waitsForSomeone(status: RepoExecutionStatus): boolean {
	return status === "needs_you" || status === "failed";
}
