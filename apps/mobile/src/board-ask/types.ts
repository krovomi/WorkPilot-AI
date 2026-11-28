/**
 * « Interroger le tableau » on the phone (`shared_board/ask.py`): a question
 * about the board is answered by the server, as a job, with the tickets that
 * relate to it, whatever language they were written in.
 */

import type { FeatureJob } from "../features/types";

export type AskState = "done" | "in_review" | "in_progress" | "planned" | "failed" | "abandoned";
export type AskCoverage = "full" | "partial" | "related";

/** A ticket that relates to the question (`BoardAskMatch` of the desktop app). */
export interface AskMatch {
	taskId: string;
	title: string;
	state: AskState;
	coverage?: AskCoverage;
	reason?: string;
	updatedAt?: string;
	archived?: boolean;
	/** Absent for a card; a roadmap feature or an idea otherwise. */
	kind?: "roadmap" | "idea";
}

export interface AskResult {
	/** Empty when no model answered: the tickets come from the keyword search. */
	answer: string;
	matches: AskMatch[];
	mode: "ai" | "keywords";
	searched: number;
}

/** `GET /api/board/ask/jobs/<id>`: the question's job, and its answer once it has one. */
export interface AskAnswer {
	job: FeatureJob;
	result: AskResult | null;
}

/** One question and what came back. */
export interface AskTurn {
	/** Its place in the conversation on this screen. */
	id: number;
	question: string;
	result: AskResult;
}

/** The earlier turns the server reads with a follow-up, as it bounds them. */
export function historyOf(turns: readonly AskTurn[]): { question: string; answer: string }[] {
	return turns.slice(-4).map((turn) => ({ question: turn.question, answer: turn.result.answer.slice(0, 4000) }));
}
