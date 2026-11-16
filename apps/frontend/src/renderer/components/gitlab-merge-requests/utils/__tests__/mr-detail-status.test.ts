/**
 * Where an MR's review stands, as its page's banner says it.
 */
import { describe, expect, it } from "vitest";
import type {
	GitLabMRReviewFinding,
	GitLabMRReviewResult,
} from "../../../../../shared/types";
import { getMRDetailStatus, isReadyToMerge } from "../mr-detail-status";

const finding = (
	id: string,
	severity: GitLabMRReviewFinding["severity"],
): GitLabMRReviewFinding => ({
	id,
	severity,
	category: "quality",
	title: id,
	description: "",
	file: "a.ts",
	line: 1,
	fixable: false,
});

const review = (
	over: Partial<GitLabMRReviewResult> = {},
): GitLabMRReviewResult => ({
	mrIid: 7,
	project: "group/app",
	success: true,
	findings: [],
	summary: "",
	overallStatus: "comment",
	reviewedAt: "2026-11-02T10:00:00Z",
	...over,
});

const none = new Set<string>();
const noCheck = null;
const status = (
	result: GitLabMRReviewResult | null,
	postedIds: ReadonlySet<string> = none,
	newCommitCount?: number,
) =>
	getMRDetailStatus({
		result,
		postedIds,
		newCommitsCheck:
			newCommitCount === undefined
				? noCheck
				: { hasNewCommits: true, newCommitCount },
	});

describe("isReadyToMerge", () => {
	it("follows the verdict or the summary's words, and never a failed review", () => {
		expect(isReadyToMerge(null)).toBe(false);
		expect(isReadyToMerge(review())).toBe(false);
		expect(isReadyToMerge(review({ overallStatus: "approve" }))).toBe(true);
		expect(isReadyToMerge(review({ summary: "Verdict: READY TO MERGE" }))).toBe(
			true,
		);
		expect(
			isReadyToMerge(review({ success: false, overallStatus: "approve" })),
		).toBe(false);
	});
});

describe("getMRDetailStatus before anything is posted", () => {
	it("asks for a review when there is none or it failed", () => {
		const expected = {
			status: "not_reviewed",
			detail: { key: "notReviewedDesc" },
		};
		expect(status(null)).toEqual(expected);
		expect(status(review({ success: false }))).toEqual(expected);
	});

	it("counts the blocking findings still to post", () => {
		const result = review({
			findings: [
				finding("a", "critical"),
				finding("b", "high"),
				finding("c", "low"),
			],
		});
		expect(status(result)).toEqual({
			status: "needs_attention",
			detail: { key: "needsPosting", values: { count: 2 } },
		});
	});

	it("counts every finding when none blocks", () => {
		const result = review({
			findings: [finding("a", "medium"), finding("b", "low")],
		});
		expect(status(result)).toEqual({
			status: "reviewed_pending_post",
			detail: { key: "foundSelectPost", values: { count: 2 } },
		});
	});
});

describe("getMRDetailStatus once findings are posted", () => {
	const blocking = review({
		findings: [finding("a", "critical"), finding("b", "low")],
	});

	it("counts a finding posted here and listed in the result once", () => {
		const result = review({ ...blocking, postedFindingIds: ["a"] });
		expect(status(result, new Set(["a", "b"]))).toEqual({
			status: "waiting_for_changes",
			detail: { key: "waiting", values: { count: 2 } },
		});
	});

	it("takes the result's word that something was posted", () => {
		const result = review({ ...blocking, hasPostedFindings: true });
		expect(status(result).status).toBe("waiting_for_changes");
	});

	it("offers a follow-up when commits arrived since the review", () => {
		expect(status(blocking, new Set(["a"]), 3)).toEqual({
			status: "ready_for_followup",
			detail: { key: "newCommitsSinceReview", values: { count: 3 } },
		});
	});

	it("reads a check without a count as no commit counted", () => {
		const reading = getMRDetailStatus({
			result: blocking,
			postedIds: new Set(["a"]),
			newCommitsCheck: { hasNewCommits: true },
		});
		expect(reading.detail.values).toEqual({ count: 0 });
	});

	it("ignores a check that found no new commit", () => {
		const reading = getMRDetailStatus({
			result: blocking,
			postedIds: new Set(["a"]),
			newCommitsCheck: { hasNewCommits: false, newCommitCount: 4 },
		});
		expect(reading.status).toBe("waiting_for_changes");
	});

	it("is ready when the verdict approves", () => {
		const result = review({ ...blocking, overallStatus: "approve" });
		expect(status(result, new Set(["a"]))).toEqual({
			status: "ready_to_merge",
			detail: { key: "noBlockers" },
		});
	});

	it("is ready when nothing posted blocks", () => {
		const result = review({ findings: [finding("b", "low")] });
		expect(status(result, new Set(["b"]))).toEqual({
			status: "ready_to_merge",
			detail: { key: "postedNoBlockers", values: { count: 1 } },
		});
	});
});

describe("getMRDetailStatus after a follow-up review", () => {
	const followup = (over: Partial<GitLabMRReviewResult>) =>
		review({ isFollowupReview: true, ...over });

	it("offers another follow-up when commits arrived since", () => {
		expect(status(followup({}), none, 1)).toEqual({
			status: "ready_for_followup",
			detail: { key: "newCommitsSinceFollowup", values: { count: 1 } },
		});
		const reading = getMRDetailStatus({
			result: followup({}),
			postedIds: none,
			newCommitsCheck: { hasNewCommits: true },
		});
		expect(reading.detail.values).toEqual({ count: 0 });
	});

	it("is ready when everything was resolved", () => {
		expect(status(followup({ resolvedFindings: ["a", "b"] }))).toEqual({
			status: "ready_to_merge",
			detail: { key: "allResolved", values: { count: 2 } },
		});
	});

	it("is ready without blockers when nothing was open", () => {
		expect(status(followup({}))).toEqual({
			status: "ready_to_merge",
			detail: { key: "noBlockers" },
		});
	});

	it("is ready when only suggestions remain open", () => {
		const result = followup({
			findings: [finding("c", "low")],
			resolvedFindings: ["a"],
			unresolvedFindings: ["c"],
			newFindingsSinceLastReview: ["d"],
		});
		expect(status(result)).toEqual({
			status: "ready_to_merge",
			detail: { key: "nonBlockingRemain", values: { count: 2, resolved: 1 } },
		});
	});

	it("counts the blockers that remain open", () => {
		const result = followup({
			findings: [finding("c", "high"), finding("d", "low")],
			unresolvedFindings: ["c", "d"],
		});
		expect(status(result)).toEqual({
			status: "followup_issues_remain",
			detail: { key: "blockingRemain", values: { count: 1, resolved: 0 } },
		});
	});
});
