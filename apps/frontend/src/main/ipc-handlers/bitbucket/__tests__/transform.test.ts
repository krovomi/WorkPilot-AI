/**
 * Bitbucket's answers made view data: typed, bounded, and a link kept only
 * when it is an https page of bitbucket.org.
 */

import { describe, expect, it } from "vitest";
import {
	bitbucketWebUrl,
	MAX_BODY,
	pipelineState,
	toComment,
	toDiffFile,
	toIssue,
	toPipeline,
	toPipelineStep,
	toPullRequest,
} from "../transform";

describe("bitbucketWebUrl", () => {
	it("keeps https pages of bitbucket.org only", () => {
		expect(bitbucketWebUrl("https://bitbucket.org/acme/web/issues/1")).toBe(
			"https://bitbucket.org/acme/web/issues/1",
		);
		for (const bad of [
			"javascript:alert(1)",
			"http://bitbucket.org/acme",
			"https://bitbucket.org.evil.example/x",
			"https://user:pw@bitbucket.org/x",
			"not a url",
			undefined,
		]) {
			expect(bitbucketWebUrl(bad)).toBe("");
		}
	});
});

describe("transforms", () => {
	it("reads an issue whatever Bitbucket left out, and bounds its body", () => {
		expect(toIssue(null)).toEqual({
			id: 0,
			title: "",
			content: "",
			state: "new",
			kind: "",
			priority: "",
			reporter: undefined,
			assignee: undefined,
			createdOn: "",
			updatedOn: "",
			webUrl: "",
		});
		const issue = toIssue({
			id: 3,
			content: "x".repeat(MAX_BODY + 10),
			reporter: { nickname: "ada" },
			assignee: { display_name: "" },
			created_on: "not a date",
		});
		expect(issue.content).toHaveLength(MAX_BODY);
		expect(issue.reporter).toEqual({ displayName: "ada", nickname: "ada" });
		expect(issue.assignee).toBeUndefined();
		expect(issue.createdOn).toBe("");
	});

	it("reads a pull request's summary when it has no description, and strips control characters", () => {
		const pr = toPullRequest({ id: 1, title: "A\u0007B", summary: { raw: "From summary" }, draft: "yes" });
		expect(pr).toMatchObject({ title: "AB", description: "From summary", draft: false, commentCount: 0 });
	});

	it("reads comments, diff files and pipelines with missing parts", () => {
		expect(toComment({ id: 2, content: "plain", inline: { path: "a.ts", from: 3 } })).toEqual({
			id: 2,
			content: "plain",
			author: undefined,
			createdOn: "",
			path: "a.ts",
			line: 3,
		});
		expect(toComment({ inline: { path: "a.ts" } })).not.toHaveProperty("line");
		expect(toDiffFile({ new: { path: "n.ts" }, status: "added" })).toEqual({
			path: "n.ts",
			status: "added",
			linesAdded: 0,
			linesRemoved: 0,
		});
		expect(toPipeline({ state: {} }, "")).toMatchObject({ state: "UNKNOWN", webUrl: "", buildNumber: 0 });
		expect(toPipeline({ build_number: 3, duration_in_seconds: -1 }, "https://bitbucket.org/a/b")).toMatchObject({
			webUrl: "https://bitbucket.org/a/b/pipelines/results/3",
			durationSeconds: undefined,
		});
		expect(pipelineState({ name: "PENDING" })).toBe("PENDING");
		expect(toPipelineStep({}).name).toBe("step");
	});
});
