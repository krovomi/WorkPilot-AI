/**
 * Best-of-N: one task built N ways, each in its own worktree with its own
 * provider, model and effort, then ranked on numbers the card shows.
 *
 * The shapes of `<spec>/best_of_n.json`, which the backend runner
 * (`runners/best_of_n_runner.py`) and the main process write. See
 * docs/architecture/best-of-n.md.
 */

import type { EngineTrio } from "./task";

export type BestOfNPhase = "running" | "ranked" | "adopted" | "discarded";

/** The criteria, in the order they decide. */
export type BestOfNCriterion = "build" | "tests" | "goal" | "diff" | "cost";

/** Why a criterion ranked nobody. */
export type BestOfNSkipReason =
	| "no_goal"
	| "goal_unchecked"
	| "diff_unknown"
	| "cost_partial";

export interface BestOfNVariant {
	index: number;
	specId: string;
	engine: EngineTrio;
	/** The build's exit code; null while it runs. */
	exitCode: number | null;
	/** The app stopped while it ran: it has no exit code and never will. */
	interrupted?: boolean;
}

export interface BestOfNScore {
	spec_id: string;
	index: number;
	engine: EngineTrio;
	exit_code: number | null;
	worktree: boolean;
	subtasks_done: number;
	subtasks_total: number;
	build_complete: boolean;
	qa_status: string | null;
	goal_status: string | null;
	goal_reason: string;
	diff_lines: number | null;
	diff_files: number | null;
	cost_usd: number | null;
	/** False when a session had no price: the cost is a floor. */
	cost_complete: boolean;
	rank: number | null;
}

export interface BestOfNRanking {
	criteria: BestOfNCriterion[];
	skipped: Partial<Record<BestOfNCriterion, BestOfNSkipReason>>;
	/** The variant that ranks first alone, with a finished build; else null. */
	recommended: string | null;
	at: string;
	variants: BestOfNScore[];
}

export interface BestOfNState {
	parent: string;
	phase: BestOfNPhase;
	createdAt: string;
	updatedAt?: string;
	variants: BestOfNVariant[];
	ranking?: BestOfNRanking;
	adopted?: { specId: string; at: string; cleanupProblems: string[] };
	discarded?: { at: string; cleanupProblems: string[] };
}

export interface BestOfNStatus {
	/** null when the task has never had a run. */
	state: BestOfNState | null;
	/** The variants whose build is running now. */
	running: string[];
	/** A step the main process is doing: setting up, ranking, adopting… */
	busy?: "preparing" | "ranking" | "adopting" | "discarding";
	error?: string;
}
