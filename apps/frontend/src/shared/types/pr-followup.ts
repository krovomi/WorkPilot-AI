/**
 * PR follow-through: the card keeps driving its pull request to merge.
 *
 * The shapes the backend runner (`runners/pr_followup_runner.py`) prints, one
 * per look at the PR, and what the main process tells the renderer about it.
 * See docs/architecture/pr-followup.md.
 */

/** What the follow-through concluded on one look at the PR. */
export type PrFollowupDecision =
	| "unknown"
	| "merged"
	| "closed"
	| "pending"
	| "no_checks"
	| "green"
	| "base_red"
	| "stuck"
	| "exhausted"
	| "fix";

/** What it did about it. */
export type PrFollowupAction =
	| "none"
	| "fixed"
	| "no_change"
	| "reverted"
	| "push_failed"
	| "fixer_error"
	| "diverged";

export interface PrFollowupRound {
	decision: PrFollowupDecision;
	reason: string;
	action: PrFollowupAction;
	head_sha: string;
	pushed_sha: string;
	detail: string;
	failing: string[];
	base_failing: string[];
	threads: string[];
	violations: string[];
	finished: boolean;
}

export interface PrFollowupStartOptions {
	/** Fix rounds before handing over to a person (0-10, default 3). */
	maxRounds?: number;
	/** Also work on unresolved review threads (default true). */
	fixReviewThreads?: boolean;
}

export interface PrFollowupStatus {
	running: boolean;
	/** The last look at the PR, if there was one since the app started. */
	round?: PrFollowupRound;
	/** Why the follow-through stopped without a round to show. */
	error?: string;
}
