/**
 * « Proposer le sprint »: the cards offered to fill a sprint up to its
 * capacity, each with why, and those that did not fit. Nothing moves until
 * the person adds them (the planning view, `assign` of the sprint store).
 *
 * Built in the main process (`main/sprint-proposal/`): the rules rank and
 * fill without a model; the person's model, when it answers, composes the
 * sprint around its goal among the ranked cards, and the rules check its
 * choice (known cards only, dependencies first, capacity kept). Points
 * only, never a duration.
 *
 * Design: docs/architecture/sprint-proposal.md.
 */

/** What the person asks the proposal to lean on (the planning view's « Relancer »). */
export type SprintProposalVariant = "balanced" | "careful" | "bugs" | "goal";
export const SPRINT_PROPOSAL_VARIANTS: readonly SprintProposalVariant[] = ["balanced", "careful", "bugs", "goal"];

/** Why the rules took a card, the first that holds; the planning view words it. */
export type SprintPickReason = "dependency" | "urgent" | "bug" | "unblocks" | "goal" | "high" | "oldest" | "fits";

export interface SprintProposalPick {
	taskId: string;
	points: number;
	reason: SprintPickReason;
	/** Open cards that wait on this one (reason `unblocks`). */
	unblocks?: number;
	/** The proposed card this one is needed by (reason `dependency`). */
	dependencyOf?: string;
	/** The model's own short reason, in the app's language, when it composed the sprint. */
	note?: string;
}

/** A card that would not fit: the sprint's points with it (and what it waits on). */
export interface SprintProposalBelow {
	taskId: string;
	points: number;
	total: number;
}

export interface SprintProposal {
	sprintId: string;
	/** The points the sprint can take, as the proposal used them. */
	capacity: number;
	/** Points already in the sprint before the proposal. */
	committed: number;
	/** Cards offered, in the order to read them (a card after what it waits on). */
	picks: SprintProposalPick[];
	/** Points of the picks. */
	points: number;
	/** The best cards that did not fit, a few at most. */
	below: SprintProposalBelow[];
	/** Plannable cards without an estimate: not counted, so not offered. */
	unestimated: string[];
	/** Cards that wait on a card that cannot join this sprint. */
	blocked: string[];
	/** A goal the model offers when the sprint has none. */
	goal?: string;
	/** The model's few sentences on the choice, in the app's language. */
	summary?: string;
	/** `ai` when the model composed it, `rules` when the rules alone did (no model, no usable answer). */
	mode: "ai" | "rules";
	variant: SprintProposalVariant;
}

export interface SprintProposalRequest {
	projectId: string;
	sprintId: string;
	variant?: SprintProposalVariant;
	/** A goal typed for this proposal; absent, the sprint's own. */
	goal?: string;
	/** Points to fill up to, for this proposal; absent, the sprint's capacity. */
	capacity?: number;
}

export const SPRINT_PROPOSAL_LIMITS = {
	/** Cards the model reads, the best ranked. */
	candidates: 40,
	/** Cards listed below the capacity line. */
	below: 3,
	goal: 500,
	note: 140,
	summary: 600,
	/** Characters of a card's description the model reads. */
	description: 240,
} as const;
