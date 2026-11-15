/**
 * Feedback on the PR reviewer's findings (#361): accept, reject or mark not
 * applicable, with an optional reason from a closed list. The main process
 * writes it to `<project>/.workpilot/code_review_feedback.jsonl`
 * (`main/ipc-handlers/github/review-feedback-store.ts`); the backend learns
 * from it (`apps/backend/learning_loop/review_feedback.py`).
 */

export const REVIEW_FEEDBACK_VERDICTS = [
	"accepted",
	"rejected",
	"not_applicable",
] as const;
export type ReviewFeedbackVerdict = (typeof REVIEW_FEEDBACK_VERDICTS)[number];

export const REVIEW_FEEDBACK_REASONS = [
	"too_pedantic",
	"project_convention",
	"false_positive",
	"legacy_exception",
	"other",
] as const;
export type ReviewFeedbackReason = (typeof REVIEW_FEEDBACK_REASONS)[number];

/** A free-text reason is one short sentence. */
export const REVIEW_FEEDBACK_NOTE_MAX = 280;

export interface ReviewFeedbackInput {
	findingId: string;
	verdict: ReviewFeedbackVerdict;
	reason?: ReviewFeedbackReason | null;
	note?: string;
}

/** The latest verdict per finding of one PR. */
export type ReviewFeedbackMap = Record<string, ReviewFeedbackVerdict>;

export type ReviewFeedbackError =
	| "invalid"
	| "not_found"
	| "server_project"
	| "write_failed";

export type ReviewFeedbackResult =
	| { success: true; feedback: ReviewFeedbackMap }
	| { success: false; error: ReviewFeedbackError };

/** A finding the project's feedback removed from a review. */
export interface LearnedSuppression {
	id: string;
	title: string;
	category: string;
	severity: string;
	file: string;
	line: number;
	rejections: number;
}
