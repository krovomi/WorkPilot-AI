import type {
	NewCommitsCheck,
	PRReviewResult,
} from "../../../../preload/api/modules/github-api";

/** Where a PR's review stands, as the list shows it and the status filter picks it. */
export type PRReviewStatus =
	| "not_reviewed"
	| "reviewing"
	| "reviewed"
	| "ready_to_merge"
	| "changes_requested"
	| "ready_for_followup";

export interface PRReviewInfo {
	isReviewing: boolean;
	result: PRReviewResult | null;
	newCommitsCheck?: NewCommitsCheck | null;
}

/** The review reached GitHub, whole or in part. */
export function hasPostedReview(result: PRReviewResult): boolean {
	return (
		Boolean(result.reviewId) ||
		Boolean(result.hasPostedFindings) ||
		Boolean(result.postedFindingIds?.length) ||
		// A follow-up with no new finding has nothing left to post.
		(Boolean(result.isFollowupReview) && result.findings?.length === 0)
	);
}

/**
 * One reading for the list and the filter: they used to decide apart, so a PR
 * the list called "Ready to Merge" could be missing from that filter.
 */
export function getPRReviewStatus(info: PRReviewInfo | null): PRReviewStatus {
	const result = info?.result;
	if (!result) return info?.isReviewing ? "reviewing" : "not_reviewed";
	if (!hasPostedReview(result)) return "reviewed";

	const check = info.newCommitsCheck;
	// Only commits pushed after the findings were posted call for a follow-up.
	if (check?.hasNewCommits && check.hasCommitsAfterPosting) {
		return "ready_for_followup";
	}
	const blocking =
		result.overallStatus === "request_changes" ||
		Boolean(
			result.findings?.some(
				(f) => f.severity === "critical" || f.severity === "high",
			),
		);
	return blocking ? "changes_requested" : "ready_to_merge";
}
