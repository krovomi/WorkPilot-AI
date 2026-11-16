/**
 * @vitest-environment node
 *
 * The PR review memories, read from a project folder as the backend writes
 * them: an index, then one file per review named by its PR number. An entry
 * whose number is not one never becomes a file name.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../../../../shared/types";
import { MAX_MEMORIES, readPRReviewMemories } from "../pr-review-memory";

let root: string;
let project: Project;
const dir = () => path.join(root, ".workpilot", "github", "memory", "shop");
const writeIndex = (index: unknown) =>
	writeFileSync(path.join(dir(), "reviews_index.json"), typeof index === "string" ? index : JSON.stringify(index));
const writeMemory = (prNumber: number, fields: Record<string, unknown> = {}) =>
	writeFileSync(
		path.join(dir(), `pr_${prNumber}_review.json`),
		JSON.stringify({ pr_number: prNumber, repo: "acme/shop", timestamp: "2026-11-01", ...fields }),
	);

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "pr-memory-"));
	project = { id: "p", name: "shop", path: root } as Project;
	mkdirSync(dir(), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("readPRReviewMemories", () => {
	it("is empty without an index, or with one that is not JSON", () => {
		expect(readPRReviewMemories(project, 10)).toEqual([]);
		writeIndex("{ not json");
		expect(readPRReviewMemories(project, 10)).toEqual([]);
		writeIndex({ reviews: "none" });
		expect(readPRReviewMemories(project, 10)).toEqual([]);
	});

	it("reads each memory of the index, with defaults for what it lacks", () => {
		writeIndex({ reviews: [{ pr_number: 3 }, { pr_number: 4 }] });
		writeMemory(3, {
			summary: { verdict: "approve" },
			key_findings: [{ severity: "low", category: "style", title: "t", description: "d", file: "a.ts", line: 1 }],
			patterns: ["p"],
			gotchas: ["g"],
			is_followup: true,
		});
		writeMemory(4);

		expect(readPRReviewMemories(project, undefined)).toEqual([
			{
				prNumber: 3,
				repo: "acme/shop",
				verdict: "approve",
				timestamp: "2026-11-01",
				summary: { verdict: "approve" },
				keyFindings: [{ severity: "low", category: "style", title: "t", description: "d", file: "a.ts", line: 1 }],
				patterns: ["p"],
				gotchas: ["g"],
				isFollowup: true,
			},
			{
				prNumber: 4,
				repo: "acme/shop",
				verdict: "unknown",
				timestamp: "2026-11-01",
				summary: undefined,
				keyFindings: [],
				patterns: [],
				gotchas: [],
				isFollowup: false,
			},
		]);
	});

	it("skips an entry that is not a PR number, a missing file and an unreadable one", () => {
		writeFileSync(path.join(root, "outside.json"), JSON.stringify({ pr_number: 99 }));
		writeIndex({
			reviews: [{ pr_number: "../../../../outside" }, { pr_number: 0 }, {}, null, { pr_number: 5 }, { pr_number: 6 }, { pr_number: 7 }],
		});
		writeFileSync(path.join(dir(), "pr_6_review.json"), "{ broken");
		writeMemory(7);

		expect(readPRReviewMemories(project, 10).map((m) => m.prNumber)).toEqual([7]);
	});

	it("stops at the limit, bounds it, and takes 10 for a limit that is not one", () => {
		const numbers = Array.from({ length: MAX_MEMORIES + 5 }, (_, i) => i + 1);
		writeIndex({ reviews: numbers.map((n) => ({ pr_number: n })) });
		for (const n of numbers) writeMemory(n);

		expect(readPRReviewMemories(project, 2)).toHaveLength(2);
		expect(readPRReviewMemories(project, 10_000)).toHaveLength(MAX_MEMORIES);
		expect(readPRReviewMemories(project, -1)).toHaveLength(10);
		expect(readPRReviewMemories(project, 2.5)).toHaveLength(10);
	});

	it("keeps only the memories whose file holds the query, whatever its case", () => {
		writeIndex({ reviews: [{ pr_number: 1 }, { pr_number: 2 }, { pr_number: 3 }] });
		writeMemory(1, { gotchas: ["Token refresh races"] });
		writeMemory(2, { gotchas: ["layout"] });
		writeMemory(3, { patterns: ["TOKEN cache"] });

		expect(readPRReviewMemories(project, 10, "token").map((m) => m.prNumber)).toEqual([1, 3]);
		expect(readPRReviewMemories(project, 1, "token").map((m) => m.prNumber)).toEqual([1]);
		// A query that is not text filters nothing.
		expect(readPRReviewMemories(project, 10, 42)).toHaveLength(3);
	});

	it("reads the memories of a project without a name under unknown", () => {
		const unnamed = { ...project, name: "" } as Project;
		const unknownDir = path.join(root, ".workpilot", "github", "memory", "unknown");
		mkdirSync(unknownDir, { recursive: true });
		writeFileSync(path.join(unknownDir, "reviews_index.json"), JSON.stringify({ reviews: [{ pr_number: 1 }] }));
		writeFileSync(path.join(unknownDir, "pr_1_review.json"), JSON.stringify({ pr_number: 1 }));

		expect(readPRReviewMemories(unnamed, 10).map((m) => m.prNumber)).toEqual([1]);
	});
});
