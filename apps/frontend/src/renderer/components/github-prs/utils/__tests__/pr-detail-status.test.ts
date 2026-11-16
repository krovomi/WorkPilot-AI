/**
 * Where the open PR's review stands, and whether it can go out as an
 * approval: the reading the PR page draws from.
 */
import { describe, expect, it } from "vitest";
import type {
	NewCommitsCheck,
	PRReviewFinding,
	PRReviewResult,
} from "../../../../../preload/api/modules/github-api";
import {
	getPRDetailStatus,
	isCleanReview,
	isReadyToMerge,
} from "../pr-detail-status";

const finding = (
	id: string,
	severity: PRReviewFinding["severity"],
): PRReviewFinding =>
	({ id, severity, category: "quality", title: id }) as PRReviewFinding;

const review = (overrides: Partial<PRReviewResult> = {}): PRReviewResult =>
	({
		prNumber: 1,
		repo: "o/r",
		success: true,
		findings: [],
		summary: "Looks fine",
		overallStatus: "comment",
		reviewedAt: "2026-11-15T00:00:00Z",
		...overrides,
	}) as PRReviewResult;

const NEW_AFTER_POSTING: NewCommitsCheck = {
	hasNewCommits: true,
	newCommitCount: 2,
	hasCommitsAfterPosting: true,
};

const status = (
	result: PRReviewResult | null,
	{
		isReviewing = false,
		postedIds = new Set<string>(),
		newCommitsCheck = null as NewCommitsCheck | null,
	} = {},
) => getPRDetailStatus({ isReviewing, result, postedIds, newCommitsCheck });

describe("getPRDetailStatus", () => {
	it("shows a running review first, even over a finished one", () => {
		expect(status(null, { isReviewing: true })).toBe("reviewing");
		expect(status(review(), { isReviewing: true })).toBe("reviewing");
	});

	it("calls a PR without a successful review not reviewed", () => {
		expect(status(null)).toBe("not_reviewed");
		expect(status(review({ success: false }))).toBe("not_reviewed");
	});

	it("before posting: blockers need attention, the rest waits to be posted", () => {
		expect(status(review({ findings: [finding("a", "low")] }))).toBe(
			"reviewed_pending_post",
		);
		expect(status(review({ findings: [finding("a", "high")] }))).toBe(
			"needs_attention",
		);
		expect(status(review({ findings: [finding("a", "critical")] }))).toBe(
			"needs_attention",
		);
	});

	it("after posting: waits on blockers, else the PR can merge", () => {
		const blocked = review({ findings: [finding("a", "high")] });
		// Posted from this page, from the stored result, or flagged by it.
		expect(status(blocked, { postedIds: new Set(["a"]) })).toBe(
			"waiting_for_changes",
		);
		expect(status({ ...blocked, postedFindingIds: ["a"] })).toBe(
			"waiting_for_changes",
		);
		expect(status({ ...blocked, hasPostedFindings: true })).toBe(
			"waiting_for_changes",
		);
		expect(
			status(review({ findings: [finding("a", "medium")], postedFindingIds: ["a"] })),
		).toBe("ready_to_merge");
		// The verdict wins over a blocker it chose to let through.
		expect(
			status({ ...blocked, postedFindingIds: ["a"], overallStatus: "approve" }),
		).toBe("ready_to_merge");
		expect(
			status({
				...blocked,
				postedFindingIds: ["a"],
				summary: "Verdict: READY TO MERGE",
			}),
		).toBe("ready_to_merge");
	});

	it("asks for a follow-up only for commits pushed after posting", () => {
		const posted = review({ findings: [finding("a", "high")], postedFindingIds: ["a"] });
		expect(status(posted, { newCommitsCheck: NEW_AFTER_POSTING })).toBe(
			"ready_for_followup",
		);
		expect(
			status(posted, {
				newCommitsCheck: { ...NEW_AFTER_POSTING, hasCommitsAfterPosting: false },
			}),
		).toBe("waiting_for_changes");
		// Nothing posted yet: new commits change nothing.
		expect(
			status(review({ findings: [finding("a", "high")] }), {
				newCommitsCheck: NEW_AFTER_POSTING,
			}),
		).toBe("needs_attention");
	});

	it("reads a follow-up review by what it left open", () => {
		const followup = (o: Partial<PRReviewResult>) =>
			review({ isFollowupReview: true, ...o });
		expect(
			status(followup({}), { newCommitsCheck: NEW_AFTER_POSTING }),
		).toBe("ready_for_followup");
		// Everything resolved, even if old findings are still listed.
		expect(
			status(
				followup({
					findings: [finding("a", "high")],
					resolvedFindings: ["a"],
					unresolvedFindings: [],
					newFindingsSinceLastReview: [],
				}),
			),
		).toBe("ready_to_merge");
		// What is left does not block.
		expect(
			status(
				followup({
					findings: [finding("b", "medium")],
					unresolvedFindings: ["b"],
				}),
			),
		).toBe("ready_to_merge");
		expect(
			status(
				followup({
					findings: [finding("c", "critical")],
					newFindingsSinceLastReview: ["c"],
				}),
			),
		).toBe("followup_issues_remain");
	});
});

describe("isCleanReview / isReadyToMerge", () => {
	it("is clean with no finding above LOW", () => {
		expect(isCleanReview(review())).toBe(true);
		expect(isCleanReview(review({ findings: [finding("a", "low")] }))).toBe(true);
		for (const severity of ["medium", "high", "critical"] as const) {
			expect(isCleanReview(review({ findings: [finding("a", severity)] }))).toBe(
				false,
			);
		}
		expect(isCleanReview(review({ success: false }))).toBe(false);
		expect(isCleanReview(null)).toBe(false);
	});

	it("is ready to merge on an approval or a READY TO MERGE summary", () => {
		expect(isReadyToMerge(review({ overallStatus: "approve" }))).toBe(true);
		expect(isReadyToMerge(review({ summary: "READY TO MERGE" }))).toBe(true);
		expect(isReadyToMerge(review({ summary: undefined as never }))).toBe(false);
		expect(isReadyToMerge(review())).toBe(false);
		expect(isReadyToMerge(review({ success: false, overallStatus: "approve" }))).toBe(
			false,
		);
		expect(isReadyToMerge(null)).toBe(false);
	});
});
