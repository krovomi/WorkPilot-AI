/**
 * Arena Mode — Blind A/B Model Comparison
 *
 * Runs the same task against several real models in parallel, anonymizes the
 * results until the user votes, then accumulates stats for data-driven
 * auto-routing.
 *
 * **A contestant is a (provider, model) pair, not a profile.** The arena used
 * to name its contestants by an opaque `profileId` that only the Claude
 * credential store could resolve, and every participant was recorded as
 * `modelName: "Model A", provider: "unknown"` — so the reveal after the vote
 * revealed nothing, and the rankings ranked a label. The identity travels with
 * the participant now, hidden by the UI until the vote, which is what "blind"
 * means: hidden from the *reader*, known to the record.
 */

export type ArenaTaskType =
	| "coding"
	| "review"
	| "test"
	| "planning"
	| "spec"
	| "insights";

export type ArenaBattleStatus =
	| "idle"
	| "running"
	| "voting"
	| "completed"
	| "error";

export type ArenaParticipantStatus =
	| "waiting"
	| "running"
	| "completed"
	| "error";

/** Anonymous label shown during the blind voting phase */
export type ArenaLabel = "A" | "B" | "C" | "D";

/** Where a contender's model id came from. Mirrors the provider catalog. */
export type ArenaContenderSource = "live" | "cache" | "registry" | "static";

/**
 * One model the user can enter into a battle: a model of a provider that is
 * actually configured on this machine.
 */
export interface ArenaContender {
	/** `${provider}:${model}` — stable across restarts, and the analytics key. */
	id: string;
	/** Canonical provider id (`anthropic`, `openai`, `ollama`, …). */
	provider: string;
	/** Human-readable provider name. */
	providerLabel: string;
	/** Model id as sent to the API. */
	model: string;
	/** Human-readable model name. */
	modelLabel: string;
	tier?: "flagship" | "standard" | "fast" | "local";
	/**
	 * `live` when the provider itself listed this model, `static` when it comes
	 * from the offline catalogue. A static entry can be a model the account is
	 * not entitled to, which is worth saying before a battle fails on it.
	 */
	source: ArenaContenderSource;
}

/** One contestant in an arena battle */
export interface ArenaParticipant {
	/** Anonymous display id (A, B, C…) — the only identity shown before the vote */
	label: ArenaLabel;
	/** `${provider}:${model}` (hidden by the UI until the vote is cast) */
	contenderId: string;
	/** Canonical provider id (hidden until vote is cast) */
	provider: string;
	/** Human-readable provider name (hidden until vote is cast) */
	providerLabel: string;
	/** Model id as sent to the API (hidden until vote is cast) */
	model: string;
	/** Human-readable model name (hidden until vote is cast) */
	modelName: string;
	status: ArenaParticipantStatus;
	/** Streamed output text */
	output: string;
	/** Total tokens — reported by the provider, or estimated (see `usageEstimated`) */
	tokensUsed: number;
	/**
	 * Cost in USD **as the provider reported it**. `undefined` means it reported
	 * nothing: the arena does not invent a price, because a made-up number is
	 * indistinguishable from a measured one once it is in a ranking. `0` from a
	 * local model is a real answer.
	 */
	costUsd?: number;
	/** True when `tokensUsed` is this app's estimate rather than a report. */
	usageEstimated: boolean;
	/** Duration in ms */
	durationMs: number;
	/** Error message if status === 'error' */
	error?: string;
}

/** A single arena battle */
export interface ArenaBattle {
	id: string;
	taskType: ArenaTaskType;
	prompt: string;
	participants: ArenaParticipant[];
	status: ArenaBattleStatus;
	createdAt: number;
	completedAt?: number;
	votedAt?: number;
	/** Label of the winner (set after vote) */
	winnerLabel?: ArenaLabel;
	/** Whether model identities have been revealed (post-vote) */
	revealed: boolean;
}

/** A single vote record */
export interface ArenaVote {
	battleId: string;
	taskType: ArenaTaskType;
	winnerLabel: ArenaLabel;
	winnerContenderId: string;
	votedAt: number;
}

/** Per-model stats aggregated across all votes */
export interface ArenaModelStats {
	contenderId: string;
	modelName: string;
	model: string;
	provider: string;
	providerLabel: string;
	wins: number;
	losses: number;
	total: number;
	winRate: number;
	/**
	 * Average over the battles whose cost the provider reported — never over
	 * the ones it did not. `undefined` when none of them did.
	 */
	avgCostPerBattle?: number;
	totalCostUsd: number;
	/** How many battles contributed a reported cost. */
	costSamples: number;
	avgDurationMs: number;
	byTaskType: Partial<
		Record<
			ArenaTaskType,
			{
				wins: number;
				total: number;
				winRate: number;
				avgCostUsd?: number;
				costSamples: number;
			}
		>
	>;
}

/** Global analytics summary */
export interface ArenaAnalytics {
	totalBattles: number;
	totalVotes: number;
	byModel: ArenaModelStats[];
	autoRoutingRecommendations: Partial<
		Record<
			ArenaTaskType,
			{
				contenderId: string;
				modelName: string;
				providerLabel: string;
				winRate: number;
				confidence: "low" | "medium" | "high";
			}
		>
	>;
	lastUpdated: number;
}

/** Progress event from main process during a running battle */
export interface ArenaBattleProgressEvent {
	battleId: string;
	label: ArenaLabel;
	chunk: string;
}

/** Completion event from main process for a single participant */
export interface ArenaBattleResultEvent {
	battleId: string;
	label: ArenaLabel;
	output: string;
	tokensUsed: number;
	costUsd?: number;
	usageEstimated: boolean;
	durationMs: number;
	error?: string;
}

/** Full battle completed event */
export interface ArenaBattleCompleteEvent {
	battleId: string;
	participants: ArenaParticipant[];
}
