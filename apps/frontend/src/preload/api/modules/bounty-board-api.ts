/**
 * Bounty Board API — renderer-side bridge for competitive multi-agent runs.
 *
 * Provider-agnostic: any combination of (provider, model) registered in the
 * backend provider registry can be submitted as a contestant.
 */

import { invokeIpc } from "./ipc-utils";

export interface BountyContestantInput {
	provider: string;
	model: string;
	profileId?: string;
	promptOverride?: string;
}

export interface BountyContestant {
	id: string;
	label: string;
	provider: string;
	model: string;
	profile_id?: string | null;
	status:
		| "queued"
		| "running"
		| "completed"
		| "error"
		| "archived"
		| "winner";
	worktree_path?: string | null;
	output: string;
	tokens_used: number;
	cost_usd: number;
	duration_ms: number;
	error?: string | null;
	score?: number | null;
	/**
	 * Points contributed per criterion, or `null` for a criterion that had no
	 * evidence. `null` and `0` are different statements — "nobody could measure
	 * this" versus "this was measured and it failed" — and the card must keep
	 * them apart, because collapsing them is how an unmeasured contest came to
	 * be reported as a close one.
	 */
	quality_breakdown: Record<string, number | null>;
	/** What the judge measured, so the card can show evidence, not just a number. */
	evidence?: BountyEvidence | null;
	branch?: string | null;
	base_ref?: string | null;
	prompt_override?: string | null;
	started_at?: number | null;
	completed_at?: number | null;
}

export interface BountyEvidence {
	diff: {
		files_changed: number;
		insertions: number;
		deletions: number;
		available: boolean;
		unavailable_reason?: string | null;
	};
	tests: {
		status:
			| "passed"
			| "failed"
			| "timeout"
			| "no-command"
			| "no-change"
			| "skipped"
			| "error";
		command?: string | null;
		passed: number;
		failed: number;
		exit_code?: number | null;
	};
}

export interface BountyResult {
	id: string;
	specId: string;
	projectPath: string;
	contestants: BountyContestant[];
	winnerId: string | null;
	judgeReport: string;
	judgeRationale: Record<string, string>;
	/** The weights the judge applied, before renormalisation. */
	scoring?: {
		weights?: Record<string, number>;
		note?: string;
		contestants?: number;
	};
	/** Signals that could not be measured for this run, and why. */
	warnings?: string[];
	createdAt: number;
	completedAt: number | null;
	status: "running" | "judging" | "completed" | "error";
}

export interface BountyBoardStartOptions {
	projectPath: string;
	specId: string;
	contestants: BountyContestantInput[];
}

export interface BountyBoardAPI {
	startBounty: (
		options: BountyBoardStartOptions,
	) => Promise<{ result: BountyResult }>;
	listBountyArchives: (options: {
		projectPath: string;
		specId: string;
	}) => Promise<{ archives: BountyResult[] }>;
}

export const createBountyBoardAPI = (): BountyBoardAPI => ({
	startBounty: (options) =>
		invokeIpc<{ result: BountyResult }>("bountyBoard:start", options),
	listBountyArchives: (options) =>
		invokeIpc<{ archives: BountyResult[] }>(
			"bountyBoard:listArchives",
			options,
		),
});
