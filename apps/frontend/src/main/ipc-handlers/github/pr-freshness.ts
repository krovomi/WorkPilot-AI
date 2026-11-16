/**
 * Whether a saved review still describes the PR: the commits pushed since it
 * (and whether they touch its findings), and the PR's merge readiness. Read
 * from the GitHub API, out of `pr-handlers.ts`.
 */

import type { PRReviewResult } from "./review-result";
import type { GitHubConfig } from "./types";
import { githubFetch } from "./utils";
import { createContextLogger } from "./utils/logger";

const { debug: debugLog } = createContextLogger("GitHub PR");

/** Result of checking for new commits since the last review. */
export interface NewCommitsCheck {
	hasNewCommits: boolean;
	newCommitCount: number;
	lastReviewedCommit?: string;
	currentHeadCommit?: string;
	/** Whether new commits happened AFTER findings were posted (for "Ready for Follow-up" status) */
	hasCommitsAfterPosting?: boolean;
	/** Whether new commits touch files that had findings (requires verification) */
	hasOverlapWithFindings?: boolean;
	/** Files from new commits that overlap with finding files */
	overlappingFiles?: string[];
	/** Whether this appears to be a merge from base branch (develop/main) */
	isMergeFromBase?: boolean;
}

/** Lightweight merge readiness, to tell whether a "ready to merge" verdict still holds. */
export interface MergeReadiness {
	/** PR is in draft mode */
	isDraft: boolean;
	/** GitHub's mergeable status */
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	/** Branch is behind base branch (out of date) */
	isBehind: boolean;
	/** Simplified CI status */
	ciStatus: "passing" | "failing" | "pending" | "none";
	/** List of blockers that contradict a "ready to merge" verdict */
	blockers: string[];
}

export const NO_NEW_COMMITS: NewCommitsCheck = { hasNewCommits: false, newCommitCount: 0 };

export const UNKNOWN_READINESS: MergeReadiness = {
	isDraft: false,
	mergeable: "UNKNOWN",
	isBehind: false,
	ciStatus: "none",
	blockers: [],
};

/** Check run conclusions that fail the CI. */
const FAILING_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out"]);

interface Comparison {
	ahead_by?: number;
	total_commits?: number;
	commits?: Array<{
		commit: { committer: { date: string }; message: string };
		parents?: Array<{ sha: string }>;
	}>;
	files?: Array<{ filename: string }>;
}

/** A review saved before the camelCase form: its snake_case fields. */
type LegacyReview = { reviewed_commit_sha?: string; posted_at?: string };

/**
 * The commits pushed to a PR since `review`: how many, whether they come after
 * its findings were posted, touch the files of its findings, or merge the base
 * branch in. A comparison GitHub cannot make (force push) still counts as new.
 */
export async function checkNewCommits(
	config: GitHubConfig,
	prNumber: number,
	review: PRReviewResult,
): Promise<NewCommitsCheck> {
	const legacy = review as unknown as LegacyReview;
	const reviewedCommitSha = review.reviewedCommitSha ?? legacy.reviewed_commit_sha;
	if (!reviewedCommitSha) return NO_NEW_COMMITS;

	let currentHeadSha: string;
	try {
		const prData = (await githubFetch(
			config.token,
			`/repos/${config.repo}/pulls/${prNumber}`,
		)) as { head: { sha: string } };
		currentHeadSha = prData.head.sha;
	} catch (error) {
		debugLog("Error fetching PR data", {
			prNumber,
			error: error instanceof Error ? error.message : error,
		});
		return NO_NEW_COMMITS;
	}

	const known = { lastReviewedCommit: reviewedCommitSha, currentHeadCommit: currentHeadSha };
	if (reviewedCommitSha === currentHeadSha) {
		return { ...NO_NEW_COMMITS, ...known, hasCommitsAfterPosting: false };
	}

	let comparison: Comparison;
	try {
		comparison = (await githubFetch(
			config.token,
			`/repos/${config.repo}/compare/${reviewedCommitSha}...${currentHeadSha}`,
		)) as Comparison;
	} catch (error) {
		// The reviewed commit is gone (force push): the SHAs differ, so it is new.
		// Overlap and merge are unknown; the view then asks to verify.
		debugLog("Comparison failed but SHAs differ, treating as new commits", {
			prNumber,
			error: error instanceof Error ? error.message : error,
		});
		return { hasNewCommits: true, newCommitCount: 1, ...known, hasCommitsAfterPosting: true };
	}

	const commits = comparison.commits ?? [];
	const postedAt = review.postedAt ?? legacy.posted_at;
	// Not posted yet: a follow-up only follows a review posted to GitHub.
	// Posted, without commit dates to compare: assume the commits came after.
	const hasCommitsAfterPosting = !postedAt
		? false
		: commits.length === 0 ||
			commits.some((c) => new Date(c.commit.committer.date) > new Date(postedAt));

	// A merge of the base branch: two parents and a merge message ("Merge
	// branch", "Merge pull request", GitHub's "Update branch"…).
	const isMergeFromBase = commits.some(
		(c) => (c.parents?.length ?? 0) >= 2 && /^merge\s+/i.test(c.commit.message),
	);

	const findingFiles = new Set((review.findings ?? []).map((f) => f.file).filter(Boolean));
	const overlappingFiles = (comparison.files ?? [])
		.map((f) => f.filename)
		.filter((f) => findingFiles.has(f));

	return {
		hasNewCommits: true,
		newCommitCount: comparison.ahead_by || comparison.total_commits || 1,
		...known,
		hasCommitsAfterPosting,
		hasOverlapWithFindings: overlappingFiles.length > 0,
		overlappingFiles: overlappingFiles.length > 0 ? overlappingFiles : undefined,
		isMergeFromBase,
	};
}

/** The CI state of a commit: its combined status, else its check runs. */
async function ciStatusOf(
	config: GitHubConfig,
	sha: string,
): Promise<MergeReadiness["ciStatus"]> {
	const status = (await githubFetch(
		config.token,
		`/repos/${config.repo}/commits/${sha}/status`,
	)) as { state: "success" | "pending" | "failure" | "error"; total_count: number };

	if (status.total_count > 0) {
		if (status.state === "success") return "passing";
		return status.state === "pending" ? "pending" : "failing";
	}

	// No commit status: GitHub Actions report check runs instead.
	const checkRuns = (await githubFetch(
		config.token,
		`/repos/${config.repo}/commits/${sha}/check-runs`,
	)) as {
		total_count: number;
		check_runs: Array<{ conclusion: string | null; status: string }>;
	};
	if (checkRuns.total_count === 0) return "none";
	if (checkRuns.check_runs.some((cr) => FAILING_CONCLUSIONS.has(cr.conclusion ?? ""))) {
		return "failing";
	}
	return checkRuns.check_runs.some((cr) => cr.status !== "completed") ? "pending" : "passing";
}

/** Draft, conflicts, out-of-date branch and CI of a PR, with what blocks merging it. */
export async function checkMergeReadiness(
	config: GitHubConfig,
	prNumber: number,
): Promise<MergeReadiness> {
	let pr: { draft: boolean; mergeable: boolean | null; mergeable_state: string; head: { sha: string } };
	try {
		pr = (await githubFetch(config.token, `/repos/${config.repo}/pulls/${prNumber}`)) as typeof pr;
	} catch (error) {
		debugLog("Failed to check merge readiness", {
			prNumber,
			error: error instanceof Error ? error.message : error,
		});
		return UNKNOWN_READINESS;
	}

	let mergeable: MergeReadiness["mergeable"] = "UNKNOWN";
	if (pr.mergeable === true) mergeable = "MERGEABLE";
	else if (pr.mergeable === false || pr.mergeable_state === "dirty") mergeable = "CONFLICTING";
	const isBehind = pr.mergeable_state === "behind";

	let ciStatus: MergeReadiness["ciStatus"] = "none";
	try {
		ciStatus = await ciStatusOf(config, pr.head.sha);
	} catch (error) {
		// Readiness without CI is still worth showing.
		debugLog("Failed to fetch CI status", {
			prNumber,
			error: error instanceof Error ? error.message : error,
		});
	}

	const blockers: string[] = [];
	if (pr.draft) blockers.push("PR is in draft mode");
	if (mergeable === "CONFLICTING") blockers.push("Merge conflicts detected");
	if (isBehind) {
		blockers.push("Branch is out of date with base branch. Update to check for conflicts.");
	}
	if (ciStatus === "failing") blockers.push("CI checks are failing");

	return { isDraft: pr.draft, mergeable, isBehind, ciStatus, blockers };
}
