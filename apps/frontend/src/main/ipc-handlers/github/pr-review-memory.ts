/**
 * The PR review memories the backend saves under
 * `.workpilot/github/memory/<project>/`: an index, then one file per review.
 * Read for the PR memory view, out of `pr-handlers.ts`.
 */

import fs from "node:fs";
import path from "node:path";
import type { Project } from "../../../shared/types";
import { getGitHubDir, sanitizeNetworkData } from "./pr-logs";
import { createContextLogger } from "./utils/logger";

const { debug: debugLog } = createContextLogger("GitHub PR");

/** Key insights and learnings kept from a PR review. */
export interface PRReviewMemory {
	prNumber: number;
	repo: string;
	verdict: string;
	timestamp: string;
	summary: {
		verdict: string;
		verdict_reasoning?: string;
		finding_counts?: Record<string, number>;
		total_findings?: number;
		blockers?: string[];
		risk_assessment?: Record<string, string>;
	};
	keyFindings: Array<{
		severity: string;
		category: string;
		title: string;
		description: string;
		file: string;
		line: number;
	}>;
	patterns: string[];
	gotchas: string[];
	isFollowup: boolean;
}

/** Most memories one call returns, whatever the renderer asks. */
export const MAX_MEMORIES = 100;

function memoryDir(project: Project): string {
	return path.join(getGitHubDir(project), "memory", project.name || "unknown");
}

function toMemory(memory: Record<string, unknown>): PRReviewMemory {
	const summary = memory.summary as PRReviewMemory["summary"] | undefined;
	return {
		prNumber: memory.pr_number as number,
		repo: memory.repo as string,
		verdict: summary?.verdict || "unknown",
		timestamp: memory.timestamp as string,
		summary: summary as PRReviewMemory["summary"],
		keyFindings: (memory.key_findings as PRReviewMemory["keyFindings"]) || [],
		patterns: (memory.patterns as string[]) || [],
		gotchas: (memory.gotchas as string[]) || [],
		isFollowup: (memory.is_followup as boolean) || false,
	};
}

/**
 * The saved memories, in index order, at most `limit`; with `query`, only
 * those whose file contains it (case-insensitive). An index entry names its
 * file by PR number, so one that is not a number is skipped, as is a file
 * that is missing or unreadable.
 */
export function readPRReviewMemories(
	project: Project,
	limit: unknown,
	query?: unknown,
): PRReviewMemory[] {
	const max =
		typeof limit === "number" && Number.isInteger(limit) && limit > 0
			? Math.min(limit, MAX_MEMORIES)
			: 10;
	const dir = memoryDir(project);
	let entries: Array<{ pr_number?: unknown }>;
	try {
		const raw = fs.readFileSync(path.join(dir, "reviews_index.json"), "utf-8");
		const index = JSON.parse(sanitizeNetworkData(raw)) as {
			reviews?: Array<{ pr_number?: unknown }>;
		};
		entries = Array.isArray(index.reviews) ? index.reviews : [];
	} catch {
		// No memory saved yet, or an index that cannot be read.
		return [];
	}

	const needle = typeof query === "string" ? query.toLowerCase() : undefined;
	const memories: PRReviewMemory[] = [];
	for (const entry of entries) {
		if (memories.length >= max) break;
		const prNumber = entry?.pr_number;
		if (!Number.isSafeInteger(prNumber) || (prNumber as number) < 1) continue;
		try {
			const content = fs.readFileSync(path.join(dir, `pr_${prNumber}_review.json`), "utf-8");
			if (needle !== undefined && !content.toLowerCase().includes(needle)) continue;
			memories.push(toMemory(JSON.parse(sanitizeNetworkData(content))));
		} catch (error) {
			// Missing (ENOENT) or not JSON: both are errors of fs and JSON.
			debugLog("Failed to load PR review memory", { prNumber, error: String(error) });
		}
	}
	return memories;
}
