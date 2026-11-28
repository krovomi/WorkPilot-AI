/**
 * GitHub and GitLab, as the phone shows them: one shape for both forges.
 * The server relays each call with the person's own token
 * (`shared_features/forge.py`, `forge_gitlab.py`); the app never holds it.
 */

export type ForgeKind = "github" | "gitlab";

export interface ForgeIssue {
	number: number;
	title: string;
	body: string;
	state: string;
	author: string | null;
	createdAt: string | null;
	comments: number | null;
	url: string | null;
}

export interface ForgeComment {
	id: string;
	author: string | null;
	body: string;
	createdAt: string | null;
}

export interface ForgePull {
	number: number;
	title: string;
	body: string;
	state: string;
	author: string | null;
	head: string | null;
	base: string | null;
	additions: number | null;
	deletions: number | null;
	updatedAt: string | null;
	url: string | null;
	/** GitHub's head commit, for its checks. */
	headSha?: string | null;
	mergeable?: boolean | null;
}

export interface ForgeFile {
	path: string;
	additions: number | null;
	deletions: number | null;
	patch: string | null;
}

export interface ReviewFinding {
	id: string;
	severity: string;
	title: string;
	description: string;
	file: string | null;
	line: number | null;
}

export type FeedbackVerdict = "accepted" | "rejected" | "not_applicable";
export const FEEDBACK_REASONS = [
	"false_positive",
	"too_pedantic",
	"project_convention",
	"legacy_exception",
	"other",
] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

/** The latest verdict per finding of a pull, and the rejections waiting for a maintainer. */
export interface FeedbackView {
	feedback: Record<string, FeedbackVerdict>;
	held: string[];
}

/** A rejection by a newcomer, held until a maintainer approves or discards it. */
export interface HeldFeedback {
	pr: number;
	finding_id: string;
	verdict: FeedbackVerdict;
	reason: FeedbackReason | null;
	title: string;
	severity: string;
}

/**
 * The feedback on the findings of the AI reviews (#361), GitHub only
 * (`shared_features/forge_review_feedback.py`): the reviewer of the project
 * learns from it, so a newcomer's rejection waits for a maintainer.
 */
export interface ReviewFeedbackApi {
	forPull(n: number): Promise<FeedbackView>;
	send(n: number, findingId: string, verdict: FeedbackVerdict, reason: FeedbackReason | null): Promise<FeedbackView>;
	/** The held rejections, and whether the person may approve or discard them. */
	held(): Promise<{ held: HeldFeedback[]; maintainer: boolean }>;
	decideHeld(pr: number, findingId: string, approve: boolean): Promise<void>;
}

/** An AI review the runner saved (`review_<n>.json`). */
export interface ForgeReview {
	summary: string;
	verdict: string | null;
	findings: ReviewFinding[];
	reviewedAt: string | null;
}
