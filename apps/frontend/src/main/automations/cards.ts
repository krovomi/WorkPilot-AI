/**
 * The card a rule creates: the same files a card typed in the app has
 * (`requirements.json`, `task_metadata.json`, a pending
 * `implementation_plan.json`), numbered under the same lock, so the board,
 * the build and the duplicate check treat it like any other card.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AUTO_BUILD_PATHS, getSpecsDir } from "../../shared/constants";
import type { AutomationRule, Project, TaskMetadata } from "../../shared/types";
import { buildEngineMetadata, uniformEngine } from "../../shared/utils/task-engine";
import { slugifySpecTitle } from "../../shared/utils/spec-slug";
import { determineCategoryFromLabels } from "../ipc-handlers/github/spec-utils";
import { sanitizeStringArray, sanitizeText, sanitizeUrl } from "../ipc-handlers/shared/sanitize";
import { withSpecNumberLock } from "../utils/spec-number-lock";
import type { AutomationEvent } from "./sources";

export interface AutomationCard {
	specId: string;
	specDir: string;
	description: string;
	metadata: TaskMetadata;
}

function specsDir(project: Project): string {
	return path.join(project.path, getSpecsDir(project.autoBuildPath));
}

/** The GitHub issues the board already has a card for, imported or not. */
export function issueNumbersOnBoard(project: Project): Set<number> {
	const numbers = new Set<number>();
	const dir = specsDir(project);
	if (!existsSync(dir)) return numbers;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		try {
			const metadata = JSON.parse(
				readFileSync(path.join(dir, entry.name, "task_metadata.json"), "utf-8"),
			) as TaskMetadata;
			if (typeof metadata.githubIssueNumber === "number") {
				numbers.add(metadata.githubIssueNumber);
			}
		} catch {
			// No metadata, or unreadable: not an issue card.
		}
	}
	return numbers;
}

export function cardMetadata(
	project: Project,
	rule: AutomationRule,
	event: AutomationEvent,
): TaskMetadata {
	const safeUrl = event.url ? sanitizeUrl(event.url) : "";
	const metadata: TaskMetadata = {
		sourceType: "automation",
		automation: {
			ruleId: rule.id,
			ruleName: rule.name,
			eventKey: event.key,
			...(safeUrl && { url: safeUrl }),
		},
		...(project.settings?.mainBranch && { baseBranch: project.settings.mainBranch }),
	};
	if (event.issue) {
		// The fields the GitHub import writes, so the import and the issue
		// views see this card as the issue's card.
		metadata.sourceType = "github";
		metadata.githubIssueNumber = event.issue.number;
		metadata.githubUrl = sanitizeUrl(event.issue.url);
		metadata.category = determineCategoryFromLabels(
			sanitizeStringArray(event.issue.labels, 50, 200),
		);
	}
	if (rule.kind) {
		// The person chose the kind when writing the rule: the classifier keeps it.
		metadata.kind = rule.kind;
		metadata.kindSource = "user";
		metadata.kindConfidence = 1;
	}
	if (rule.engine) {
		Object.assign(metadata, buildEngineMetadata(uniformEngine(rule.engine)));
	}
	return metadata;
}

export async function createAutomationCard(
	project: Project,
	rule: AutomationRule,
	event: AutomationEvent,
): Promise<AutomationCard> {
	const dir = specsDir(project);
	mkdirSync(dir, { recursive: true });
	// Network-sourced text is bounded and stripped before it reaches the disk.
	const title = sanitizeText(event.title, 200) || rule.name;
	const description = sanitizeText(event.description, 50000, true) || title;
	const metadata = cardMetadata(project, rule, event);

	return withSpecNumberLock(project.path, (lock) => {
		const number = lock.getNextSpecNumber(project.autoBuildPath);
		const specId = `${String(number).padStart(3, "0")}-${slugifySpecTitle(title)}`;
		const specDir = path.join(dir, specId);
		mkdirSync(specDir, { recursive: true });
		const now = new Date().toISOString();
		const write = (name: string, value: unknown) =>
			writeFileSync(path.join(specDir, name), JSON.stringify(value, null, 2), "utf-8");
		write(AUTO_BUILD_PATHS.REQUIREMENTS, {
			task_description: description,
			workflow_type: "feature",
		});
		write("task_metadata.json", metadata);
		write(AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN, {
			feature: title,
			description,
			created_at: now,
			updated_at: now,
			status: "pending",
			phases: [],
		});
		return { specId, specDir, description, metadata };
	});
}
