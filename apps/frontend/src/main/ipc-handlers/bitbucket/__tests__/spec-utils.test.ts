/**
 * @vitest-environment node
 *
 * A Bitbucket issue made a task: its text with the fields Bitbucket gave,
 * and a spec with Bitbucket's origin, even when most fields are missing.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BitbucketIssue, Project } from "../../../../shared/types";
import { buildBitbucketIssueContext, createSpecForBitbucketIssue } from "../spec-utils";

const bare: BitbucketIssue = {
	id: 9,
	title: "",
	content: "",
	state: "new",
	kind: "",
	priority: "",
	createdOn: "",
	updatedOn: "",
	webUrl: "",
};

describe("buildBitbucketIssueContext", () => {
	it("writes only what the issue has", () => {
		const text = buildBitbucketIssueContext(bare, "acme/web", [
			{ id: 1, content: "Hello", createdOn: "" },
			{ id: 2, content: "", createdOn: "" },
		]);
		expect(text).toContain("_No description provided_");
		expect(text).not.toContain("**Kind:**");
		expect(text).not.toContain("**URL:**");
		expect(text).toContain("**unknown** ():");
		expect(text.match(/\*\*unknown\*\*/g)).toHaveLength(1);
		expect(buildBitbucketIssueContext(bare, "acme/web")).not.toContain("## Comments");
	});
});

describe("createSpecForBitbucketIssue", () => {
	let dir = "";
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("names a task without title after its issue, with no base branch", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "bb-spec-"));
		const project = { id: "p", path: dir, autoBuildPath: ".workpilot" } as Project;
		const { specDir } = await createSpecForBitbucketIssue(project, bare, "");
		const metadata = JSON.parse(readFileSync(path.join(specDir, "task_metadata.json"), "utf-8"));
		expect(metadata).toEqual({ sourceType: "bitbucket", bitbucketIssueId: 9, bitbucketUrl: "", category: "feature" });
		const requirements = JSON.parse(readFileSync(path.join(specDir, "requirements.json"), "utf-8"));
		expect(requirements.task_description).toBe("Bitbucket issue 9");
	});
});
