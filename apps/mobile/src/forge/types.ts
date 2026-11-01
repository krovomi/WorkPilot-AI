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

/** An AI review the runner saved (`review_<n>.json`). */
export interface ForgeReview {
	summary: string;
	verdict: string | null;
	findings: ReviewFinding[];
	reviewedAt: string | null;
}
