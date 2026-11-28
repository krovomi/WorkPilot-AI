/**
 * « Interroger le tableau »: a question about the board, answered with the
 * tickets that relate to it (docs/architecture/board-ask.md).
 */

/** Where a ticket stands, in words a product owner reads. */
export type BoardAskState = "done" | "in_review" | "in_progress" | "planned" | "failed" | "abandoned";

/** How much of what the question asks a ticket already holds, per the model. */
export type BoardAskCoverage = "full" | "partial" | "related";

export const BOARD_ASK_COVERAGES: readonly BoardAskCoverage[] = ["full", "partial", "related"];

/** An earlier question of the same conversation and the answer it got. */
export interface BoardAskTurn {
	question: string;
	answer: string;
}

export interface BoardAskRequest {
	projectId: string;
	question: string;
	/** The conversation so far, oldest first; only the last few are read. */
	history?: BoardAskTurn[];
}

export interface BoardAskMatch {
	taskId: string;
	title: string;
	state: BoardAskState;
	/** Absent when no model judged it (keyword answer). */
	coverage?: BoardAskCoverage;
	/** One line, in the language of the question, on why it relates. */
	reason?: string;
	/** ISO date of the ticket's last change. */
	updatedAt?: string;
	archived?: boolean;
}

/**
 * Whether the tickets are also ranked by meaning (an embeddings model):
 * `auto` asks a model on this machine, else the chosen provider's embeddings
 * API; `local` only the machine's; `off` none.
 */
export type BoardAskSemanticMode = "auto" | "local" | "off";

export const BOARD_ASK_SEMANTIC_MODES: readonly BoardAskSemanticMode[] = ["auto", "local", "off"];

/** The embeddings model that ranked the tickets, and how much of the board it read. */
export interface BoardAskSemantic {
	kind: "local" | "cloud";
	provider: string;
	model: string;
	/** Tickets it has read; a large board is read over a few questions. */
	indexed: number;
	total: number;
}

export interface BoardAskResult {
	/**
	 * The model's answer, in the language of the question. `[1]`, `[2]`… cite
	 * `matches[0]`, `matches[1]`…; empty for a keyword answer.
	 */
	answer: string;
	matches: BoardAskMatch[];
	/**
	 * `ai`: a model read the tickets; `semantic`: no model answered, the
	 * tickets are ranked by meaning and keywords; `keywords`: by keywords alone.
	 */
	mode: "ai" | "semantic" | "keywords";
	/** Tickets of the board that were searched. */
	searched: number;
	/** The words searched besides the question's own, when a model gave them. */
	expandedTerms?: string[];
	/** Set when an embeddings model ranked the tickets too. */
	semantic?: BoardAskSemantic;
}

/** Bounds the main process holds the renderer to. */
export const BOARD_ASK_LIMITS = {
	question: 1000,
	historyTurns: 4,
	turnText: 4000,
} as const;
