/**
 * @vitest-environment node
 *
 * Whether a saved review still holds, read from a stand-in GitHub API: the
 * commits pushed since it and what they touch, and the merge readiness of
 * the PR (draft, conflicts, out-of-date branch, CI by status or check runs).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	routes: new Map<string, unknown>(),
	calls: [] as string[],
}));

vi.mock("../utils", () => ({
	githubFetch: vi.fn(async (_token: string, endpoint: string) => {
		state.calls.push(endpoint);
		const answer = state.routes.get(endpoint);
		// Something that is not an error, as a library may throw.
		if (answer === "throw-text") throw "down";
		if (answer === undefined || answer instanceof Error) throw answer ?? new Error(`404 ${endpoint}`);
		return answer;
	}),
}));

import {
	checkMergeReadiness,
	checkNewCommits,
	NO_NEW_COMMITS,
	UNKNOWN_READINESS,
} from "../pr-freshness";
import type { PRReviewResult } from "../review-result";

const config = { token: "pat-test-0000", repo: "acme/shop" };
const route = (endpoint: string, answer: unknown) => state.routes.set(`/repos/acme/shop${endpoint}`, answer);
const review = (fields: Partial<PRReviewResult> & Record<string, unknown>) =>
	({ prNumber: 7, findings: [], ...fields }) as unknown as PRReviewResult;
const commit = (date: string, message = "fix: tidy", parents = 1) => ({
	commit: { committer: { date }, message },
	parents: Array.from({ length: parents }, (_, i) => ({ sha: `p${i}` })),
});

beforeEach(() => {
	state.routes.clear();
	state.calls = [];
});

describe("checkNewCommits", () => {
	it("has nothing to compare without the reviewed commit", async () => {
		await expect(checkNewCommits(config, 7, review({}))).resolves.toEqual(NO_NEW_COMMITS);
		expect(state.calls).toEqual([]);
	});

	it("answers no new commit when the PR cannot be read", async () => {
		await expect(
			checkNewCommits(config, 7, review({ reviewedCommitSha: "aaa" })),
		).resolves.toEqual(NO_NEW_COMMITS);
	});

	it("answers no new commit when the head is the reviewed commit", async () => {
		route("/pulls/7", { head: { sha: "aaa" } });

		await expect(checkNewCommits(config, 7, review({ reviewedCommitSha: "aaa" }))).resolves.toEqual({
			hasNewCommits: false,
			newCommitCount: 0,
			lastReviewedCommit: "aaa",
			currentHeadCommit: "aaa",
			hasCommitsAfterPosting: false,
		});
	});

	it("counts the commits after the posted review, the files they share with findings, and a merge of the base", async () => {
		route("/pulls/7", { head: { sha: "bbb" } });
		route("/compare/aaa...bbb", {
			ahead_by: 2,
			commits: [
				commit("2026-11-01T10:00:00Z"),
				commit("2026-11-03T10:00:00Z", "Merge branch 'develop' into feat", 2),
			],
			files: [{ filename: "src/a.ts" }, { filename: "src/c.ts" }],
		});

		const result = await checkNewCommits(
			config,
			7,
			review({
				reviewedCommitSha: "aaa",
				postedAt: "2026-11-02T00:00:00Z",
				findings: [{ file: "src/a.ts" }, { file: "src/b.ts" }, { file: "" }] as never,
			}),
		);

		expect(result).toEqual({
			hasNewCommits: true,
			newCommitCount: 2,
			lastReviewedCommit: "aaa",
			currentHeadCommit: "bbb",
			hasCommitsAfterPosting: true,
			hasOverlapWithFindings: true,
			overlappingFiles: ["src/a.ts"],
			isMergeFromBase: true,
		});
	});

	it("reads a review saved in snake_case, with commits all before its posting", async () => {
		route("/pulls/7", { head: { sha: "bbb" } });
		route("/compare/aaa...bbb", {
			total_commits: 1,
			commits: [commit("2026-11-01T10:00:00Z", "Merge pull request #3", 1)],
		});

		const result = await checkNewCommits(
			config,
			7,
			review({ reviewed_commit_sha: "aaa", posted_at: "2026-11-02T00:00:00Z" }),
		);

		expect(result).toMatchObject({
			newCommitCount: 1,
			hasCommitsAfterPosting: false,
			hasOverlapWithFindings: false,
			overlappingFiles: undefined,
			// A merge message with one parent is not a merge.
			isMergeFromBase: false,
		});
	});

	it("does not offer a follow-up before the review is posted, and counts at least one commit", async () => {
		route("/pulls/7", { head: { sha: "bbb" } });
		route("/compare/aaa...bbb", {});

		const result = await checkNewCommits(config, 7, review({ reviewedCommitSha: "aaa" }));

		expect(result).toMatchObject({ newCommitCount: 1, hasCommitsAfterPosting: false, isMergeFromBase: false });
	});

	it("assumes commits after a posted review when the comparison has no commit", async () => {
		route("/pulls/7", { head: { sha: "bbb" } });
		route("/compare/aaa...bbb", { ahead_by: 3, commits: [] });

		const result = await checkNewCommits(
			config,
			7,
			review({ reviewedCommitSha: "aaa", postedAt: "2026-11-02T00:00:00Z" }),
		);

		expect(result.hasCommitsAfterPosting).toBe(true);
	});

	it("reads a commit without parents and a review without findings", async () => {
		route("/pulls/7", { head: { sha: "bbb" } });
		route("/compare/aaa...bbb", {
			commits: [{ commit: { committer: { date: "2026-11-01T10:00:00Z" }, message: "Merge x" } }],
			files: [{ filename: "src/a.ts" }],
		});

		const result = await checkNewCommits(config, 7, review({ reviewedCommitSha: "aaa", findings: undefined }));

		expect(result).toMatchObject({ isMergeFromBase: false, hasOverlapWithFindings: false });
	});

	it("survives failures that are not errors", async () => {
		route("/pulls/7", "throw-text");
		await expect(checkNewCommits(config, 7, review({ reviewedCommitSha: "aaa" }))).resolves.toEqual(NO_NEW_COMMITS);
		await expect(checkMergeReadiness(config, 7)).resolves.toEqual(UNKNOWN_READINESS);

		route("/pulls/7", { head: { sha: "bbb" }, draft: false, mergeable: true, mergeable_state: "clean" });
		route("/compare/aaa...bbb", "throw-text");
		route("/commits/bbb/status", "throw-text");
		await expect(checkNewCommits(config, 7, review({ reviewedCommitSha: "aaa" }))).resolves.toMatchObject({
			hasNewCommits: true,
		});
		await expect(checkMergeReadiness(config, 7)).resolves.toMatchObject({ ciStatus: "none" });
	});

	it("counts new commits when the reviewed one is gone (force push)", async () => {
		route("/pulls/7", { head: { sha: "bbb" } });
		route("/compare/aaa...bbb", new Error("404 No common ancestor"));

		await expect(checkNewCommits(config, 7, review({ reviewedCommitSha: "aaa" }))).resolves.toEqual({
			hasNewCommits: true,
			newCommitCount: 1,
			lastReviewedCommit: "aaa",
			currentHeadCommit: "bbb",
			hasCommitsAfterPosting: true,
		});
	});
});

describe("checkMergeReadiness", () => {
	const pr = (fields: Record<string, unknown>) =>
		route("/pulls/7", { draft: false, mergeable: true, mergeable_state: "clean", head: { sha: "h1" }, ...fields });
	const status = (state: string, total = 1) => route("/commits/h1/status", { state, total_count: total });
	const checks = (runs: Array<{ conclusion: string | null; status: string }>) =>
		route("/commits/h1/check-runs", { total_count: runs.length, check_runs: runs });

	it("is unknown when the PR cannot be read", async () => {
		await expect(checkMergeReadiness(config, 7)).resolves.toEqual(UNKNOWN_READINESS);
	});

	it.each([
		["success", "passing"],
		["pending", "pending"],
		["failure", "failing"],
		["error", "failing"],
	])("reads the combined status %s as %s", async (combined, ciStatus) => {
		pr({});
		status(combined);

		const result = await checkMergeReadiness(config, 7);

		expect(result.ciStatus).toBe(ciStatus);
		expect(result.blockers).toEqual(ciStatus === "failing" ? ["CI checks are failing"] : []);
		expect(state.calls).not.toContain("/repos/acme/shop/commits/h1/check-runs");
	});

	it.each([
		[[{ conclusion: "success", status: "completed" }], "passing"],
		[[{ conclusion: null, status: "in_progress" }, { conclusion: "success", status: "completed" }], "pending"],
		[[{ conclusion: "cancelled", status: "completed" }], "failing"],
		[[{ conclusion: "timed_out", status: "completed" }], "failing"],
		[[{ conclusion: "failure", status: "completed" }, { conclusion: null, status: "queued" }], "failing"],
		[[], "none"],
	])("reads check runs %j as %s when there is no commit status", async (runs, ciStatus) => {
		pr({});
		status("pending", 0);
		checks(runs);

		await expect(checkMergeReadiness(config, 7)).resolves.toMatchObject({ ciStatus });
	});

	it("names every blocker of a draft, conflicting, out-of-date PR", async () => {
		pr({ draft: true, mergeable: null, mergeable_state: "behind" });
		status("failure");

		await expect(checkMergeReadiness(config, 7)).resolves.toEqual({
			isDraft: true,
			mergeable: "UNKNOWN",
			isBehind: true,
			ciStatus: "failing",
			blockers: [
				"PR is in draft mode",
				"Branch is out of date with base branch. Update to check for conflicts.",
				"CI checks are failing",
			],
		});
	});

	it.each([
		[{ mergeable: false }, "CONFLICTING"],
		[{ mergeable: null, mergeable_state: "dirty" }, "CONFLICTING"],
		[{ mergeable: true }, "MERGEABLE"],
	])("reads %j as %s", async (fields, mergeable) => {
		pr(fields);
		status("success");

		const result = await checkMergeReadiness(config, 7);

		expect(result.mergeable).toBe(mergeable);
		expect(result.blockers.includes("Merge conflicts detected")).toBe(mergeable === "CONFLICTING");
	});

	it("keeps the readiness without CI when the status cannot be read", async () => {
		pr({});

		await expect(checkMergeReadiness(config, 7)).resolves.toEqual({
			isDraft: false,
			mergeable: "MERGEABLE",
			isBehind: false,
			ciStatus: "none",
			blockers: [],
		});
	});
});
