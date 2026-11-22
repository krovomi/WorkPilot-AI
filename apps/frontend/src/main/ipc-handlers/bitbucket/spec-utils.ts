/**
 * A Bitbucket issue made a task: the same spec the GitHub import writes
 * (`github/spec-utils.ts`: coordinated spec number, `requirements.json`,
 * `task_metadata.json`), with Bitbucket's origin. The issue's text and its
 * comments are external content: bounded and stripped here, then handled by
 * the spec pipeline like any imported issue — data, never an instruction.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AUTO_BUILD_PATHS, getSpecsDir } from "../../../shared/constants";
import type {
	BitbucketComment,
	BitbucketIssue,
	Project,
	TaskMetadata,
} from "../../../shared/types";
import { slugifySpecTitle } from "../../../shared/utils/spec-slug";
import { withSpecNumberLock } from "../../utils/spec-number-lock";
import { determineCategoryFromLabels } from "../github/spec-utils";
import { sanitizeText } from "../shared/sanitize";

/** Comments a task carries at most, and each one's length. */
const MAX_COMMENTS = 30;
const MAX_COMMENT = 5_000;
const MAX_DESCRIPTION = 50_000;

/** The task text: the issue's fields, its description, then its comments, oldest first. */
export function buildBitbucketIssueContext(
	issue: BitbucketIssue,
	repoFullName: string,
	comments: readonly BitbucketComment[] = [],
): string {
	const lines = [
		`# Bitbucket Issue #${issue.id}: ${issue.title}`,
		"",
		`**Repository:** ${sanitizeText(repoFullName, 300)}`,
		`**State:** ${issue.state}`,
		...(issue.kind ? [`**Kind:** ${issue.kind}`] : []),
		...(issue.priority ? [`**Priority:** ${issue.priority}`] : []),
		"",
		"## Description",
		"",
		issue.content || "_No description provided_",
	];
	const kept = comments.filter((c) => c.content).slice(0, MAX_COMMENTS);
	if (kept.length > 0) {
		lines.push("", "## Comments", "");
		for (const comment of kept) {
			lines.push(`**${comment.author?.displayName ?? "unknown"}** (${comment.createdOn.slice(0, 10)}):`);
			lines.push("", sanitizeText(comment.content, MAX_COMMENT, true), "");
		}
	}
	if (issue.webUrl) lines.push("", `**URL:** ${issue.webUrl}`);
	return lines.join("\n");
}

export interface BitbucketSpec {
	specId: string;
	specDir: string;
}

/** Writes the spec of an issue (already transformed by `toIssue`) and returns its id. */
export async function createSpecForBitbucketIssue(
	project: Project,
	issue: BitbucketIssue,
	description: string,
	baseBranch?: string,
): Promise<BitbucketSpec> {
	const specsDir = path.join(project.path, getSpecsDir(project.autoBuildPath));
	mkdirSync(specsDir, { recursive: true });
	const title = sanitizeText(issue.title, 500) || `Bitbucket issue ${issue.id}`;
	const taskDescription = sanitizeText(description, MAX_DESCRIPTION, true);

	return await withSpecNumberLock(project.path, async (lock) => {
		const specNumber = lock.getNextSpecNumber(project.autoBuildPath);
		const specId = `${String(specNumber).padStart(3, "0")}-${slugifySpecTitle(title)}`;
		const specDir = path.join(specsDir, specId);
		mkdirSync(specDir, { recursive: true });
		writeFileSync(
			path.join(specDir, AUTO_BUILD_PATHS.REQUIREMENTS),
			JSON.stringify({ task_description: taskDescription || title, workflow_type: "feature" }, null, 2),
			"utf-8",
		);
		const metadata: TaskMetadata = {
			sourceType: "bitbucket",
			bitbucketIssueId: issue.id,
			bitbucketUrl: issue.webUrl,
			category: determineCategoryFromLabels([issue.kind].filter(Boolean)),
			...(baseBranch ? { baseBranch } : {}),
		};
		writeFileSync(path.join(specDir, "task_metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");
		return { specId, specDir };
	});
}
