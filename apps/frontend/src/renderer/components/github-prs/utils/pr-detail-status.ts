import type {
	NewCommitsCheck,
	PRReviewFinding,
	PRReviewResult,
} from "../../../../preload/api/modules/github-api";
import type { ReviewStatus } from "../components/ReviewStatusTree";

const isBlocking = (finding: PRReviewFinding) =>
	finding.severity === "critical" || finding.severity === "high";

/** The review says the PR can merge as it stands. */
export function isReadyToMerge(result: PRReviewResult | null): boolean {
	if (!result?.success) return false;
	return (
		Boolean(result.summary?.includes("READY TO MERGE")) ||
		result.overallStatus === "approve"
	);
}

/** Nothing above LOW was found: the review can go out as an approval. */
export function isCleanReview(result: PRReviewResult | null): boolean {
	if (!result?.success) return false;
	return !result.findings.some(
		(f) =>
			f.severity === "critical" ||
			f.severity === "high" ||
			f.severity === "medium",
	);
}

/**
 * Where the open PR's review stands, as its page shows it. A running review
 * comes first, so going back to a PR under review shows it running.
 */
export function getPRDetailStatus({
	isReviewing,
	result,
	postedIds,
	newCommitsCheck,
}: {
	isReviewing: boolean;
	result: PRReviewResult | null;
	/** Findings posted from this page, which the result may not list yet. */
	postedIds: ReadonlySet<string>;
	newCommitsCheck: NewCommitsCheck | null;
}): ReviewStatus {
	if (isReviewing) return "reviewing";
	if (!result?.success) return "not_reviewed";

	const posted =
		postedIds.size > 0 ||
		Boolean(result.postedFindingIds?.length) ||
		Boolean(result.hasPostedFindings);
	// Only commits pushed after the review was posted call for a follow-up.
	const followupDue = Boolean(
		newCommitsCheck?.hasNewCommits && newCommitsCheck.hasCommitsAfterPosting,
	);
	const blocked = result.findings.some(isBlocking);

	if (result.isFollowupReview) {
		if (followupDue) return "ready_for_followup";
		const allResolved =
			!result.unresolvedFindings?.length &&
			!result.newFindingsSinceLastReview?.length;
		return allResolved || !blocked ? "ready_to_merge" : "followup_issues_remain";
	}

	if (posted) {
		if (followupDue) return "ready_for_followup";
		return isReadyToMerge(result) || !blocked
			? "ready_to_merge"
			: "waiting_for_changes";
	}
	// Nothing posted yet: every blocker still has to reach the author.
	return blocked ? "needs_attention" : "reviewed_pending_post";
}
