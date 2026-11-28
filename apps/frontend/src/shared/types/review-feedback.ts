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
	| {
			success: true;
			feedback: ReviewFeedbackMap;
			/**
			 * Server projects (lot 3): the findings whose rejection waits for a
			 * maintainer; the reviewer does not learn from it until approved.
			 */
			held?: string[];
	  }
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

/** What a learned rule does to a matching finding (lot 2 of #361). */
export type LearnedRuleStatus = "downgraded" | "dropped";

/** The verdicts on one category, the latest per finding. */
export interface ReviewFeedbackCategoryStats {
	category: string;
	accepted: number;
	rejected: number;
	notApplicable: number;
}

/** A kind of remark the project rejected often enough to change the reviews. */
export interface ReviewFeedbackRuleStats {
	signature: string;
	category: string;
	/** Its newest wording, one bounded line. */
	label: string;
	rejections: number;
	accepts: number;
	status: LearnedRuleStatus;
	topReason: ReviewFeedbackReason | null;
}

/** A server project's rejection by a member, waiting for a maintainer (lot 3). */
export interface HeldRejection {
	prNumber: number;
	findingId: string;
	verdict: Exclude<ReviewFeedbackVerdict, "accepted">;
	reason: ReviewFeedbackReason | null;
	note: string;
	category: string;
	/** The finding's title, one bounded line. */
	label: string;
}

/** What a server project adds to the view (lot 3). */
export interface ReviewFeedbackServerStats {
	/** The person may reset a rule and decide a held rejection. */
	maintainer: boolean;
	held: HeldRejection[];
}

/**
 * One month of the project's reviews (lot 4), computed on the machine or on
 * the team's server: the PRs whose saved review ran that month, their
 * findings in total, and the kinds of remark the reviewer learned then.
 */
export interface ReviewFeedbackMonth {
	/** `YYYY-MM`. */
	month: string;
	reviews: number;
	findings: number;
	rulesLearned: number;
}

export interface ReviewFeedbackStats {
	threshold: number;
	categories: ReviewFeedbackCategoryStats[];
	rules: ReviewFeedbackRuleStats[];
	/** The newest months first, six at most. */
	months: ReviewFeedbackMonth[];
	/** Set for a server project, whose feedback the server keeps. */
	server?: ReviewFeedbackServerStats;
}

export type ReviewFeedbackStatsResult =
	| { success: true; stats: ReviewFeedbackStats }
	| { success: false; error: ReviewFeedbackError };

/**
 * `.workpilot/review-conventions.md`, written on request. A server project's
 * is saved where the person chooses (`path` is then the full path); closing
 * that dialog answers `cancelled`.
 */
export type ReviewConventionsResult =
	| { success: true; path: string; rules: number }
	| { success: false; error: ReviewFeedbackError | "cancelled" };
