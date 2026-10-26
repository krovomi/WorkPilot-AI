/**
 * Goal mode: a task is done when a command exits with the expected code,
 * within a number of QA passes and a spending cap (apps/backend/goal/).
 *
 * The goal is written by the main process to `<spec>/.workpilot-goal.json`,
 * a file no agent may write; the verdict comes back in the plan (`goal`).
 */

export interface TaskGoal {
	/** One command line, run in the worktree without a shell. */
	command: string;
	expectedExit?: number;
	timeoutSeconds?: number;
	/** QA passes the goal may spend; absent keeps the effort-based cap. */
	maxRounds?: number;
	/** What the whole task may spend, in US dollars; absent is no cap. */
	maxCostUsd?: number;
	/** Repository paths (globs) the task may not change, e.g. `tests/**`. */
	protected?: string[];
}

export type TaskGoalStatus = "met" | "unmet" | "error" | "invalid" | "budget";

/** The last verdict, as the plan carries it for the card. */
export interface TaskGoalSummary {
	status: TaskGoalStatus;
	reason: string;
	spentUsd?: number | null;
	/** False when a session's cost could not be priced: the spend is a floor. */
	spendComplete?: boolean | null;
	at?: string;
}

export interface TaskGoalState {
	goal: TaskGoal | null;
	/** Set when the goal file is there but cannot be read. */
	error?: string;
}
