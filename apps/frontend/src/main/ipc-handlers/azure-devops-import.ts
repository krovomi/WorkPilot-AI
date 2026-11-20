/**
 * A work item imported as a task: its spec folder (`requirements.json`,
 * `task_metadata.json`, the captures of its description as attachments) and
 * the task the board shows. Everything read from the work item is external
 * content: the title becomes one line of plain text, the description is cut
 * and cleaned before it reaches the spec pipeline, and the url is checked.
 * `azure-devops-handlers.ts` fetches the work items and calls this per item.
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AUTO_BUILD_PATHS } from "../../shared/constants";
import type { AzureDevOpsWorkItem, Task, TaskCategory, TaskMetadata, TaskPriority } from "../../shared/types";
import { parseAcceptanceCriteriaText, stripAcceptanceCriteriaSection } from "../../shared/utils/acceptance-criteria";
import { slugifySpecTitle } from "../../shared/utils/spec-slug";
import { inlineAzureDevOpsImages, saveInlinedImagesAsAttachments } from "./shared/azure-attachments";
import { sanitizeText, sanitizeUrl, stripControlChars, stripHtml } from "./shared/sanitize";

/** What an import needs besides the work item. */
export interface ImportContext {
	projectId: string;
	specsDir: string;
	pat: string;
	orgUrl: string;
	requireReviewBeforeCoding?: boolean;
}

/** A work item's title as one line of plain text. */
export const plainTitle = (title: unknown): string => sanitizeText(stripHtml(title).replace(/\s+/g, " "), 200);

/** The number the next spec folder takes: one more than the highest there. */
export function nextSpecNumber(specsDir: string): number {
	const numbers = readdirSync(specsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => Number.parseInt(/^(\d+)/.exec(entry.name)?.[1] ?? "0", 10));
	return Math.max(0, ...numbers) + 1;
}

/**
 * A bug is a bug fix, anything else (a story, a feature, a task, a custom
 * type) a feature: the categories a card has, which the board filters on.
 */
const categoryOf = (type: string): TaskCategory => (type.toLowerCase() === "bug" ? "bug_fix" : "feature");

/** Azure DevOps ranks 1 (highest) to 4. */
const priorityOf = (priority?: number): TaskPriority => {
	if (!priority) return "medium";
	if (priority <= 1) return "high";
	return priority >= 3 ? "low" : "medium";
};

/** The task description the spec pipeline reads: plain text, the work item's fields first. */
function specDescription(
	item: AzureDevOpsWorkItem,
	title: string,
	identifier: string,
	description: string,
	criteria: string[],
): string {
	const lines = [`# ${title}`, "", `**Source:** Azure DevOps ${item.workItemType} ${identifier}`];
	if (item.state) lines.push(`**State:** ${item.state}`);
	if (item.priority) lines.push(`**Priority:** ${item.priority}`);
	if (item.areaPath) lines.push(`**Area:** ${sanitizeText(item.areaPath, 200)}`);
	if (item.iterationPath) lines.push(`**Iteration:** ${sanitizeText(item.iterationPath, 200)}`);
	if (item.tags && item.tags.length > 0) {
		lines.push(`**Tags:** ${item.tags.map((tag) => sanitizeText(tag, 100)).join(", ")}`);
	}
	lines.push("", "## Description", "", (description && stripHtml(description)) || title);
	if (criteria.length > 0) {
		lines.push("", "## Acceptance Criteria", "", ...criteria.map((criterion) => `- ${criterion}`));
	}
	return lines.join("\n");
}

/** Writes the spec folder of one work item under `specId` and gives its task. */
export async function importWorkItem(item: AzureDevOpsWorkItem, specId: string, context: ImportContext): Promise<Task> {
	const title = plainTitle(item.title);
	const description = item.description
		? stripAcceptanceCriteriaSection(sanitizeText(item.description, 5000))
		: "";
	// The rich description is kept for display, its Azure DevOps images
	// (behind the PAT) inlined so that the renderer shows them.
	const displayDescription = item.description
		? await inlineAzureDevOpsImages(
				stripAcceptanceCriteriaSection(stripControlChars(item.description, true)),
				context.orgUrl,
				context.pat,
			)
		: "";
	const identifier = sanitizeText(`ADO-${item.id}`, 100);
	const criteria = parseAcceptanceCriteriaText(item.acceptanceCriteria);
	const category = categoryOf(item.workItemType);

	const specDir = path.join(context.specsDir, specId);
	mkdirSync(specDir, { recursive: true });
	// The captures are also attachments: that is where agents read them.
	saveInlinedImagesAsAttachments(displayDescription, specDir, `ado-${item.id}`);

	const metadata: TaskMetadata = {
		sourceType: "imported",
		category,
		priority: priorityOf(item.priority),
		azureDevOpsIdentifier: identifier,
		azureDevOpsUrl: item.url ? sanitizeUrl(item.url) : "",
		azureDevOpsState: item.state,
		azureDevOpsType: item.workItemType,
		...(criteria.length > 0 && { acceptanceCriteria: criteria }),
		...(context.requireReviewBeforeCoding && { requireReviewBeforeCoding: true }),
	};
	// No implementation_plan.json: the planner writes it from the spec, and
	// an empty one made it fail its validation.
	const requirements: Record<string, unknown> = {
		task_description: specDescription(item, title, identifier, description, criteria),
		workflow_type: category === "bug_fix" ? "bugfix" : "feature",
		// The scanner shows these first: the accented title (the folder name is
		// a slug) and the description with its images.
		...(title && { display_title: title }),
		...(displayDescription && { display_description: displayDescription }),
		...(criteria.length > 0 && { acceptance_criteria: criteria }),
	};
	writeFileSync(path.join(specDir, AUTO_BUILD_PATHS.REQUIREMENTS), JSON.stringify(requirements, null, 2), "utf-8");
	writeFileSync(path.join(specDir, "task_metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");

	const now = new Date();
	return {
		id: specId,
		specId,
		projectId: context.projectId,
		title,
		description: displayDescription || description,
		status: "backlog",
		subtasks: [],
		logs: [],
		metadata,
		createdAt: now,
		updatedAt: now,
	};
}

/** The spec folder name of a title: its number, then its slug. */
export const specIdOf = (number: number, title: string): string =>
	`${String(number).padStart(3, "0")}-${slugifySpecTitle(title) || "task"}`;
