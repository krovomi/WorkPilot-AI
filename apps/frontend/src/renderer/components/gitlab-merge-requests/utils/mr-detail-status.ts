import type {
	GitLabMRReviewFinding,
	GitLabMRReviewResult,
	GitLabNewCommitsCheck,
} from "../../../../shared/types";

/** Where the open MR's review stands, as the banner of its page shows it. */
export type MRDetailStatus =
	| "not_reviewed"
	| "reviewed_pending_post"
	| "waiting_for_changes"
	| "ready_to_merge"
	| "needs_attention"
	| "ready_for_followup"
	| "followup_issues_remain";

export interface MRDetailReading {
	status: MRDetailStatus;
	/** The banner's second line: a key under `gitlab:mrReview.status` and its values. */
	detail: { key: string; values?: { count: number; resolved?: number } };
}

const isBlocking = (f: GitLabMRReviewFinding) =>
	f.severity === "critical" || f.severity === "high";

/** The review says the MR can merge as it stands. */
export function isReadyToMerge(result: GitLabMRReviewResult | null): boolean {
	if (!result?.success) return false;
	return (
		Boolean(result.summary?.includes("READY TO MERGE")) ||
		result.overallStatus === "approve"
	);
}

export function getMRDetailStatus({
	result,
	postedIds,
	newCommitsCheck,
}: {
	result: GitLabMRReviewResult | null;
	/** Findings posted from this page, which the result may not list yet. */
	postedIds: ReadonlySet<string>;
	newCommitsCheck: GitLabNewCommitsCheck | null;
}): MRDetailReading {
	if (!result?.success) {
		return { status: "not_reviewed", detail: { key: "notReviewedDesc" } };
	}
	// One set: a finding posted here is usually in the result too, and used
	// to be counted twice.
	const posted = new Set([...postedIds, ...(result.postedFindingIds ?? [])]);
	const hasPosted = posted.size > 0 || Boolean(result.hasPostedFindings);
	const newCommits = newCommitsCheck?.hasNewCommits
		? (newCommitsCheck.newCommitCount ?? 0)
		: 0;
	const blockers = result.findings.filter(isBlocking).length;

	if (result.isFollowupReview) {
		const resolved = result.resolvedFindings?.length ?? 0;
		const open =
			(result.unresolvedFindings?.length ?? 0) +
			(result.newFindingsSinceLastReview?.length ?? 0);
		if (newCommitsCheck?.hasNewCommits) {
			return {
				status: "ready_for_followup",
				detail: { key: "newCommitsSinceFollowup", values: { count: newCommits } },
			};
		}
		if (open === 0) {
			return {
				status: "ready_to_merge",
				detail: resolved
					? { key: "allResolved", values: { count: resolved } }
					: { key: "noBlockers" },
			};
		}
		if (blockers === 0) {
			return {
				status: "ready_to_merge",
				detail: { key: "nonBlockingRemain", values: { count: open, resolved } },
			};
		}
		return {
			status: "followup_issues_remain",
			detail: { key: "blockingRemain", values: { count: blockers, resolved } },
		};
	}

	if (hasPosted) {
		if (newCommitsCheck?.hasNewCommits) {
			return {
				status: "ready_for_followup",
				detail: { key: "newCommitsSinceReview", values: { count: newCommits } },
			};
		}
		if (isReadyToMerge(result)) {
			return { status: "ready_to_merge", detail: { key: "noBlockers" } };
		}
		return blockers > 0
			? {
					status: "waiting_for_changes",
					detail: { key: "waiting", values: { count: posted.size } },
				}
			: {
					status: "ready_to_merge",
					detail: { key: "postedNoBlockers", values: { count: posted.size } },
				};
	}

	return blockers > 0
		? {
				status: "needs_attention",
				detail: { key: "needsPosting", values: { count: blockers } },
			}
		: {
				status: "reviewed_pending_post",
				detail: {
					key: "foundSelectPost",
					values: { count: result.findings.length },
				},
			};
}
