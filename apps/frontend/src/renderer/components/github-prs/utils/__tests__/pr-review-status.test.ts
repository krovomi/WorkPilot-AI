/**
 * Where a PR's review stands. The list's dots and the status filter both read
 * it from here, so a PR always sits under the filter named like its label.
 */
import { describe, expect, it } from "vitest";
import type { PRReviewResult } from "../../../../../preload/api/modules/github-api";
import { getPRReviewStatus } from "../pr-review-status";

const result = (fields: Partial<PRReviewResult> = {}) =>
	({ findings: [], overallStatus: "approve", ...fields }) as PRReviewResult;

describe("getPRReviewStatus", () => {
	it.each([
		["nothing known", null, "not_reviewed"],
		["no review yet", { isReviewing: false, result: null }, "not_reviewed"],
		["a first review running", { isReviewing: true, result: null }, "reviewing"],
		["a review kept here", { isReviewing: false, result: result() }, "reviewed"],
		// A rerun keeps showing the review it already has.
		["a rerun of a kept review", { isReviewing: true, result: result() }, "reviewed"],
	] as const)("%s", (_, info, status) => {
		expect(getPRReviewStatus(info)).toBe(status);
	});

	it.each([
		["posted as a review", { reviewId: 7 }],
		["posted as findings", { hasPostedFindings: true }],
		["with some findings posted", { postedFindingIds: ["f1"] }],
		["a follow-up with nothing new", { isFollowupReview: true }],
	])("reads a review %s as posted", (_, fields) => {
		expect(getPRReviewStatus({ isReviewing: false, result: result(fields) })).toBe(
			"ready_to_merge",
		);
	});

	it("keeps a follow-up with new findings to post as reviewed", () => {
		const followUp = result({
			isFollowupReview: true,
			findings: [{ severity: "low" }] as never,
		});
		expect(getPRReviewStatus({ isReviewing: false, result: followUp })).toBe(
			"reviewed",
		);
	});

	it("asks for changes when the review does, or a finding is serious", () => {
		const posted = { reviewId: 1 };
		const status = (fields: Partial<PRReviewResult>) =>
			getPRReviewStatus({ isReviewing: false, result: result({ ...posted, ...fields }) });
		expect(status({ overallStatus: "request_changes" })).toBe("changes_requested");
		expect(status({ findings: [{ severity: "high" }] as never })).toBe(
			"changes_requested",
		);
		expect(status({ findings: [{ severity: "critical" }] as never })).toBe(
			"changes_requested",
		);
		expect(status({ findings: [{ severity: "medium" }] as never })).toBe(
			"ready_to_merge",
		);
	});

	it("calls for a follow-up only after commits pushed since posting", () => {
		const info = (hasCommitsAfterPosting: boolean) => ({
			isReviewing: false,
			result: result({ reviewId: 1, overallStatus: "request_changes" }),
			newCommitsCheck: { hasNewCommits: true, hasCommitsAfterPosting } as never,
		});
		expect(getPRReviewStatus(info(true))).toBe("ready_for_followup");
		expect(getPRReviewStatus(info(false))).toBe("changes_requested");
	});
});
