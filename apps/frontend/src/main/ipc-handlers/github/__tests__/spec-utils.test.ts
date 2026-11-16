/**
 * @vitest-environment node
 *
 * The spec a GitHub issue becomes, written to a real project folder: the
 * issue's text is network data, so it is cleaned and bounded before it
 * reaches the disk; the number comes from the shared spec lock; the labels
 * pick the task category. The plan status update tolerates a spec that has
 * no plan yet and reports one it cannot rewrite.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const debug = vi.hoisted(() => vi.fn());
vi.mock("../utils/logger", () => ({ debugLog: debug }));

import type { Project } from "../../../../shared/types";
import {
	buildInvestigationTask,
	buildIssueContext,
	createSpecForIssue,
	determineCategoryFromLabels,
	updateImplementationPlanStatus,
} from "../spec-utils";

let root: string;
let project: Project;
const read = (file: string) => JSON.parse(readFileSync(file, "utf-8"));

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "gh-spec-utils-"));
	project = { id: "p", name: "P", path: root, autoBuildPath: ".workpilot" } as Project;
	debug.mockReset();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("determineCategoryFromLabels", () => {
	it.each([
		[["Bug"], "bug_fix"],
		[["defect"], "bug_fix"],
		[["CVE-2026-1"], "security"],
		[["vulnerability"], "security"],
		[["speed"], "performance"],
		[["optimization"], "performance"],
		[["UX polish"], "ui_ux"],
		[["styling"], "ui_ux"],
		[["devops"], "infrastructure"],
		[["ci"], "infrastructure"],
		[["area: cd"], "infrastructure"],
		[["qa"], "testing"],
		[["tech-debt"], "refactoring"],
		[["technical debt"], "refactoring"],
		[["chore"], "refactoring"],
		[["docs"], "documentation"],
		[["enhancement"], "feature"],
		[[], "feature"],
	])("reads %j as %s", (labels, category) => {
		expect(determineCategoryFromLabels(labels)).toBe(category);
	});

	it("does not take a word that merely contains ci or cd for infrastructure", () => {
		expect(determineCategoryFromLabels(["acid"])).toBe("feature");
		expect(determineCategoryFromLabels(["decide"])).toBe("feature");
	});

	it("lets a bug label win over the others", () => {
		expect(determineCategoryFromLabels(["documentation", "bug"])).toBe("bug_fix");
	});
});

describe("createSpecForIssue", () => {
	it("writes the requirements and the metadata of the issue", async () => {
		const spec = await createSpecForIssue(
			project,
			42,
			"Login fails on Safari",
			"Steps:\n1. open\n2. fail",
			"https://github.com/acme/shop/issues/42",
			["bug", "safari"],
			"develop",
		);

		expect(spec.specId).toMatch(/^001-login-fails-on-safari/);
		expect(spec.specDir).toBe(path.join(root, ".workpilot", "specs", spec.specId));
		expect(read(path.join(spec.specDir, "requirements.json"))).toEqual({
			task_description: "Steps:\n1. open\n2. fail",
			workflow_type: "feature",
		});
		expect(read(path.join(spec.specDir, "task_metadata.json"))).toEqual({
			sourceType: "github",
			githubIssueNumber: 42,
			githubUrl: "https://github.com/acme/shop/issues/42",
			category: "bug_fix",
			baseBranch: "develop",
		});
		expect(spec.metadata.category).toBe("bug_fix");
		// The planner writes the plan from the spec it generates.
		expect(existsSync(path.join(spec.specDir, "implementation_plan.json"))).toBe(false);
	});

	it("cleans what the network sent before it reaches the disk", async () => {
		const spec = await createSpecForIssue(
			project,
			7,
			`Title\u0000 with control${"x".repeat(600)}`,
			"",
			"javascript:alert(1)",
			["docs\u0007", "", 3 as unknown as string],
		);

		const metadata = read(path.join(spec.specDir, "task_metadata.json"));
		expect(metadata.githubUrl).toBe("");
		expect(metadata.category).toBe("documentation");
		expect(metadata).not.toHaveProperty("baseBranch");
		const requirements = read(path.join(spec.specDir, "requirements.json"));
		// No description: the title stands for it, bounded and without control characters.
		expect(requirements.task_description).not.toContain("\u0000");
		expect(requirements.task_description.length).toBeLessThanOrEqual(500);
		expect(requirements.task_description.startsWith("Title")).toBe(true);
	});

	it("numbers after the specs already there", async () => {
		mkdirSync(path.join(root, ".workpilot", "specs", "004-older"), { recursive: true });

		const spec = await createSpecForIssue(project, 1, "Next", "d", "https://github.com/a/b/issues/1");

		expect(spec.specId).toMatch(/^005-/);
	});
});

describe("buildIssueContext and buildInvestigationTask", () => {
	it("lays out the issue with its comments and labels", () => {
		const context = buildIssueContext(
			9,
			"Crash",
			"It crashes",
			["bug", "p1"],
			"https://github.com/a/b/issues/9",
			[
				{ body: "same here", user: { login: "ana" } },
				{ body: "fixed?", user: { login: "bo" } },
			],
		);

		expect(context).toContain("# GitHub Issue #9: Crash");
		expect(context).toContain("It crashes");
		expect(context).toContain("## Comments (2):");
		expect(context).toContain("**ana:** same here\n\n**bo:** fixed?");
		expect(context).toContain("**Labels:** bug, p1");
		expect(context).toContain("**URL:** https://github.com/a/b/issues/9");

		const task = buildInvestigationTask(9, "Crash", context);
		expect(task.startsWith("Investigate GitHub Issue #9: Crash")).toBe(true);
		expect(task).toContain(context);
		expect(task).toContain("5. Acceptance criteria");
	});

	it("says so when the issue has no body, comments or labels", () => {
		const context = buildIssueContext(1, "Empty", undefined, [], "https://x.invalid", []);

		expect(context).toContain("No description provided.");
		expect(context).not.toContain("## Comments");
		expect(context).toContain("**Labels:** None");
	});
});

describe("updateImplementationPlanStatus", () => {
	it("sets the status and the update time of the plan", () => {
		const plan = path.join(root, "implementation_plan.json");
		writeFileSync(plan, JSON.stringify({ status: "backlog", phases: [] }));

		updateImplementationPlanStatus(root, "planning");

		const written = read(plan);
		expect(written.status).toBe("planning");
		expect(Number.isNaN(Date.parse(written.updated_at))).toBe(false);
		expect(written.phases).toEqual([]);
	});

	it("stays quiet for a spec without a plan, and reports a plan it cannot read", () => {
		updateImplementationPlanStatus(root, "planning");
		expect(debug).not.toHaveBeenCalled();

		writeFileSync(path.join(root, "implementation_plan.json"), "{broken");
		updateImplementationPlanStatus(root, "planning");
		expect(debug).toHaveBeenCalledWith(
			"spec-utils",
			expect.stringContaining("Failed to update implementation plan status"),
		);
	});
});
