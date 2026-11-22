/**
 * The panel's figures by month (#361, lot 4): the findings of each saved
 * review, read inside the project only and bounded, and the month each kind
 * of remark the reviewer now hides or downgrades reached the threshold.
 */
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../project-store", () => ({
	projectStore: { getProjects: () => [] },
}));

import { type FeedbackRecord, monthOf, parseDataset } from "../review-feedback-dataset";
import {
	MAX_COUNTED_REVIEWS,
	MONTHS_SHOWN,
	monthlyMetrics,
	readReviewCounts,
	reviewCount,
	rulesLearnedByMonth,
	serverReviewCounts,
} from "../review-feedback-metrics";

let root: string;
let project: string;
let reviews: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "review-metrics-")));
	project = path.join(root, "project");
	reviews = path.join(project, ".workpilot", "github", "pr");
	mkdirSync(reviews, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function save(name: string, content: unknown): void {
	writeFileSync(
		path.join(reviews, name),
		typeof content === "string" ? content : JSON.stringify(content),
	);
}

/** Dataset lines: [category, title, verdict, at]. */
function records(lines: Array<[string, string, string, string | undefined]>): FeedbackRecord[] {
	return parseDataset(
		lines
			.map(([category, title, verdict, at], i) =>
				JSON.stringify({
					v: 1,
					at,
					pr: i + 1,
					finding_id: `f${i}`,
					verdict,
					reason: null,
					category,
					severity: "low",
					title,
				}),
			)
			.join("\n"),
	);
}

describe("monthOf", () => {
	it("reads the month of an ISO timestamp, nothing else", () => {
		expect(monthOf("2026-11-21T10:00:00+00:00")).toBe("2026-11");
		expect(monthOf("2026-13-01T00:00:00")).toBeNull();
		expect(monthOf("2026-11-21")).toBeNull();
		expect(monthOf(20261121)).toBeNull();
	});
});

describe("reviewCount", () => {
	it("counts a list of findings, or takes a whole number", () => {
		expect(reviewCount(4, "2026-11-01T00:00:00", [1, 2])).toEqual({
			pr: 4,
			month: "2026-11",
			findings: 2,
		});
		expect(reviewCount(4, "2026-11-01T00:00:00", 7)?.findings).toBe(7);
	});

	it.each([
		["a pr that is not a number", "4", "2026-11-01T00:00:00", []],
		["a fractional pr", 1.5, "2026-11-01T00:00:00", []],
		["a pr of zero", 0, "2026-11-01T00:00:00", []],
		["a pr too large", 1_000_000_000, "2026-11-01T00:00:00", []],
		["no date", 4, undefined, []],
		["a negative count", 4, "2026-11-01T00:00:00", -1],
		["a fractional count", 4, "2026-11-01T00:00:00", 1.5],
		["no findings", 4, "2026-11-01T00:00:00", "many"],
	])("refuses %s", (_label, pr, at, findings) => {
		expect(reviewCount(pr, at, findings)).toBeNull();
	});
});

describe("readReviewCounts", () => {
	it("reads each saved review of the project, the newest PRs first", () => {
		save("review_3.json", { reviewed_at: "2026-10-01T00:00:00", findings: [1, 2, 3] });
		save("review_12.json", { reviewed_at: "2026-11-01T00:00:00", findings: [] });
		save("review_4.json", "{broken");
		save("review_5.json", [1, 2]);
		save("review_6.json", { reviewed_at: "x", findings: [] });
		save("review_07.json", { reviewed_at: "2026-11-01T00:00:00", findings: [] });
		save("notes.json", {});

		expect(readReviewCounts(project)).toEqual([
			{ pr: 12, month: "2026-11", findings: 0 },
			{ pr: 3, month: "2026-10", findings: 3 },
		]);
	});

	it("skips a review too large to read, a link and a folder", () => {
		save("review_1.json", "x".repeat(2_000_001));
		const outside = path.join(root, "outside.json");
		writeFileSync(outside, JSON.stringify({ reviewed_at: "2026-11-01T00:00:00", findings: [1] }));
		symlinkSync(outside, path.join(reviews, "review_2.json"));
		save("review_3.json", { reviewed_at: "2026-11-01T00:00:00", findings: [] });
		mkdirSync(path.join(reviews, "review_4.json"));

		expect(readReviewCounts(project).map((c) => c.pr)).toEqual([3]);
	});

	it("keeps the newest reviews only", () => {
		for (let pr = 10; pr < 10 + MAX_COUNTED_REVIEWS + 1; pr += 1) {
			save(`review_${pr}.json`, { reviewed_at: "2026-11-01T00:00:00", findings: [] });
		}

		const counts = readReviewCounts(project);

		expect(counts).toHaveLength(MAX_COUNTED_REVIEWS);
		expect(counts.map((c) => c.pr)).not.toContain(10);
	});

	it("reads nothing without the folder, through a folder link, or when it cannot list it", () => {
		expect(readReviewCounts(path.join(root, "nowhere"))).toEqual([]);
		const other = path.join(root, "other");
		mkdirSync(path.join(other, ".workpilot", "github"), { recursive: true });
		symlinkSync(reviews, path.join(other, ".workpilot", "github", "pr"), "dir");
		expect(readReviewCounts(other)).toEqual([]);
		expect(
			readReviewCounts(project, () => {
				throw new Error("EACCES");
			}),
		).toEqual([]);
	});
});

describe("serverReviewCounts", () => {
	it("keeps what has the shape of a count, bounded", () => {
		const valid = { pr: 2, at: "2026-11-01T00:00:00", findings: 3 };
		expect(serverReviewCounts("many")).toEqual([]);
		expect(serverReviewCounts([null, "x", { pr: -1 }, valid])).toEqual([
			{ pr: 2, month: "2026-11", findings: 3 },
		]);
		expect(
			serverReviewCounts(Array.from({ length: MAX_COUNTED_REVIEWS + 5 }, () => valid)),
		).toHaveLength(MAX_COUNTED_REVIEWS);
	});
});

describe("rulesLearnedByMonth", () => {
	it("counts a rule in the month it reached the threshold, if it is still there", () => {
		const learned = rulesLearnedByMonth(
			records([
				// Crosses in October.
				["style", "Missing docstring on `a`", "rejected", "2026-09-30T00:00:00"],
				["style", "Missing docstring on `b`", "rejected", "2026-10-02T00:00:00"],
				// Crosses in September, falls under in October, crosses again in November.
				["quality", "Prefer an early return", "rejected", "2026-09-01T00:00:00"],
				["quality", "Prefer an early return!", "not_applicable", "2026-09-02T00:00:00"],
				["quality", "prefer an early return", "accepted", "2026-10-01T00:00:00"],
				["quality", "Prefer an early return.", "rejected", "2026-11-01T00:00:00"],
				// Crosses, then is accepted again: not a rule any more.
				["docs", "Typo in comment", "rejected", "2026-09-01T00:00:00"],
				["docs", "Typo in comment.", "rejected", "2026-09-02T00:00:00"],
				["docs", "typo in comment", "accepted", "2026-09-03T00:00:00"],
				// Crosses on a line without a date: not counted.
				["test", "Missing test", "rejected", "2026-09-01T00:00:00"],
				["test", "Missing test.", "rejected", undefined],
				// Security is never learned.
				["security", "Hardcoded key", "rejected", "2026-09-01T00:00:00"],
				["security", "Hardcoded key.", "rejected", "2026-09-02T00:00:00"],
			]),
			2,
		);

		expect([...learned.entries()].sort()).toEqual([
			["2026-10", 1],
			["2026-11", 1],
		]);
	});
});

describe("monthlyMetrics", () => {
	it("puts reviews and rules side by side, the newest months first, bounded", () => {
		const months = Array.from({ length: MONTHS_SHOWN + 2 }, (_, i) =>
			`2026-${String(i + 1).padStart(2, "0")}`,
		);
		const rows = monthlyMetrics(
			records([
				["style", "Nit on `a`", "rejected", "2026-08-01T00:00:00"],
				["style", "Nit on `b`", "rejected", "2026-08-02T00:00:00"],
			]),
			[
				...months.map((month, i) => ({ pr: i + 1, month, findings: 2 })),
				{ pr: 99, month: "2026-08", findings: 5 },
			],
			2,
		);

		expect(rows).toHaveLength(MONTHS_SHOWN);
		expect(rows[0]).toEqual({ month: "2026-08", reviews: 2, findings: 7, rulesLearned: 1 });
		expect(rows[1]).toEqual({ month: "2026-07", reviews: 1, findings: 2, rulesLearned: 0 });
		expect(rows.at(-1)?.month).toBe("2026-03");
	});

	it("shows a month with a learned rule and no review", () => {
		expect(
			monthlyMetrics(
				records([
					["style", "Nit on `a`", "rejected", "2026-08-01T00:00:00"],
					["style", "Nit on `b`", "rejected", "2026-08-02T00:00:00"],
				]),
				[],
				2,
			),
		).toEqual([{ month: "2026-08", reviews: 0, findings: 0, rulesLearned: 1 }]);
	});
});
