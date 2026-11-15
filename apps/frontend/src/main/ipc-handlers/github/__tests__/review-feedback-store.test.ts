/**
 * The feedback dataset on PR review findings (#361): the renderer's
 * arguments are refused unless every one is what it should be, the finding's
 * kind is read from the saved review (never from the renderer), and the file
 * stays inside the project.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../project-store", () => ({
	projectStore: { getProjects: () => [] },
}));

import {
	FEEDBACK_RELATIVE_PATH,
	KEEP_LINES_ON_COMPACT,
	readFeedback,
	recordFeedback,
	validateFeedback,
} from "../review-feedback-store";

function must<T>(value: T | null): T {
	if (value === null) throw new Error("expected a valid feedback");
	return value;
}

let root: string;
let project: string;

function writeReview(prNumber: number, findings: unknown[]): void {
	const dir = path.join(project, ".workpilot", "github", "pr");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(dir, `review_${prNumber}.json`),
		JSON.stringify({ pr_number: prNumber, findings }),
		"utf-8",
	);
}

const FINDING = {
	id: "f-1",
	category: "style",
	severity: "low",
	title: "Missing docstring on `foo`",
};

function lines(): Array<Record<string, unknown>> {
	return readFileSync(path.join(project, FEEDBACK_RELATIVE_PATH), "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "review-feedback-")));
	project = path.join(root, "project");
	mkdirSync(project);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("validateFeedback", () => {
	it("accepts a well-formed rejection with a reason and a note", () => {
		expect(
			validateFeedback(12, {
				findingId: "f-1",
				verdict: "rejected",
				reason: "too_pedantic",
				note: "  we\nallow\tthis  ",
			}),
		).toEqual({
			prNumber: 12,
			findingId: "f-1",
			verdict: "rejected",
			reason: "too_pedantic",
			note: "we allow this",
		});
	});

	it("drops the reason and note of an acceptance", () => {
		expect(
			validateFeedback(1, {
				findingId: "f",
				verdict: "accepted",
				reason: "other",
				note: "x",
			}),
		).toMatchObject({ reason: null, note: "" });
	});

	it.each([
		["a PR number that is not a positive integer", -1, {}],
		["a PR number given as text", "12", {}],
		["a fractional PR number", 1.5, {}],
		["no input object", 1, null],
		["an array input", 1, [{ findingId: "f", verdict: "rejected" }]],
		["a path as finding id", 1, { findingId: "../../etc/passwd", verdict: "rejected" }],
		["an over-long finding id", 1, { findingId: "a".repeat(129), verdict: "rejected" }],
		["an unknown verdict", 1, { findingId: "f", verdict: "approve_everything" }],
		["an unknown reason", 1, { findingId: "f", verdict: "rejected", reason: "rm -rf /" }],
		["a note that is not text", 1, { findingId: "f", verdict: "rejected", note: { x: 1 } }],
		["a note too long", 1, { findingId: "f", verdict: "rejected", note: "x".repeat(281) }],
	])("refuses %s", (_label, prNumber, input) => {
		expect(validateFeedback(prNumber, input)).toBeNull();
	});
});

describe("recordFeedback", () => {
	it("stores the finding's kind as the saved review has it", () => {
		writeReview(7, [FINDING]);
		const valid = validateFeedback(7, {
			findingId: "f-1",
			verdict: "rejected",
			reason: "project_convention",
			// The renderer cannot pass a category or a title: extra keys are ignored.
			category: "security",
			title: "SQL injection",
		});
		expect(valid).not.toBeNull();
		const result = recordFeedback(project, must(valid), () => new Date(0));
		expect(result).toEqual({ success: true, feedback: { "f-1": "rejected" } });
		expect(lines()).toEqual([
			{
				v: 1,
				at: "1970-01-01T00:00:00.000Z",
				pr: 7,
				finding_id: "f-1",
				verdict: "rejected",
				reason: "project_convention",
				note: "",
				category: "style",
				severity: "low",
				title: "Missing docstring on `foo`",
			},
		]);
	});

	it("refuses a finding the saved review does not have", () => {
		writeReview(7, [FINDING]);
		const valid = validateFeedback(7, { findingId: "other", verdict: "rejected" });
		expect(recordFeedback(project, must(valid))).toEqual({
			success: false,
			error: "not_found",
		});
	});

	it.each([
		["no saved review", null],
		["a review that is not JSON", "{not json"],
		["a review without findings", JSON.stringify({ findings: "none" })],
		["a review that is null", "null"],
	])("refuses a finding when there is %s", (_label, content) => {
		if (content !== null) {
			const dir = path.join(project, ".workpilot", "github", "pr");
			mkdirSync(dir, { recursive: true });
			writeFileSync(path.join(dir, "review_7.json"), content);
		}
		const valid = validateFeedback(7, { findingId: "f-1", verdict: "rejected" });
		expect(recordFeedback(project, must(valid))).toEqual({
			success: false,
			error: "not_found",
		});
	});

	it("skips entries that are not findings", () => {
		writeReview(7, [null, "f-1", 3, FINDING]);
		const valid = validateFeedback(7, { findingId: "f-1", verdict: "accepted" });
		expect(recordFeedback(project, must(valid)).success).toBe(true);
	});

	it("answers write_failed when the dataset cannot be appended to", () => {
		writeReview(7, [FINDING]);
		// A folder where the file should be: the append fails.
		mkdirSync(path.join(project, FEEDBACK_RELATIVE_PATH), { recursive: true });
		const valid = validateFeedback(7, { findingId: "f-1", verdict: "rejected" });
		expect(recordFeedback(project, must(valid))).toEqual({
			success: false,
			error: "write_failed",
		});
	});

	it("refuses a saved finding whose kind is malformed", () => {
		writeReview(7, [{ ...FINDING, category: "Style; DROP TABLE" }]);
		const valid = validateFeedback(7, { findingId: "f-1", verdict: "rejected" });
		expect(recordFeedback(project, must(valid)).success).toBe(false);
	});

	it("never writes through a .workpilot link that leaves the project", () => {
		const outside = path.join(root, "outside");
		mkdirSync(path.join(outside, "github", "pr"), { recursive: true });
		writeFileSync(
			path.join(outside, "github", "pr", "review_7.json"),
			JSON.stringify({ findings: [FINDING] }),
		);
		try {
			symlinkSync(outside, path.join(project, ".workpilot"), "dir");
		} catch {
			return; // No symlinks on this machine: nothing to escape through.
		}
		const valid = validateFeedback(7, { findingId: "f-1", verdict: "rejected" });
		expect(recordFeedback(project, must(valid)).success).toBe(false);
		expect(() =>
			statSync(path.join(outside, "code_review_feedback.jsonl")),
		).toThrow();
	});

	it("never writes through a dataset file that is a link", () => {
		writeReview(7, [FINDING]);
		const target = path.join(project, "elsewhere.txt");
		writeFileSync(target, "keep\n");
		try {
			symlinkSync(target, path.join(project, FEEDBACK_RELATIVE_PATH));
		} catch {
			return;
		}
		const valid = validateFeedback(7, { findingId: "f-1", verdict: "rejected" });
		expect(recordFeedback(project, must(valid))).toEqual({
			success: false,
			error: "write_failed",
		});
		expect(readFileSync(target, "utf-8")).toBe("keep\n");
	});

	it("keeps the newest lines once the file grows past its bound", () => {
		writeReview(7, [FINDING]);
		const file = path.join(project, FEEDBACK_RELATIVE_PATH);
		const filler = JSON.stringify({ v: 1, pr: 1, finding_id: "old", pad: "x".repeat(500) });
		writeFileSync(file, `${`${filler}\n`.repeat(2_500)}`);
		const valid = validateFeedback(7, { findingId: "f-1", verdict: "accepted" });
		expect(recordFeedback(project, must(valid)).success).toBe(true);
		const kept = lines();
		expect(kept).toHaveLength(KEEP_LINES_ON_COMPACT);
		expect(kept.at(-1)).toMatchObject({ finding_id: "f-1", verdict: "accepted" });
	});
});

describe("readFeedback", () => {
	it("is empty without a dataset, and through a link", () => {
		expect(readFeedback(project, 3)).toEqual({});
		const target = path.join(project, "elsewhere.jsonl");
		writeFileSync(
			target,
			`${JSON.stringify({ v: 1, pr: 3, finding_id: "a", verdict: "rejected" })}\n`,
		);
		mkdirSync(path.join(project, ".workpilot"), { recursive: true });
		try {
			symlinkSync(target, path.join(project, FEEDBACK_RELATIVE_PATH));
		} catch {
			return;
		}
		expect(readFeedback(project, 3)).toEqual({});
	});

	it("turns control characters of a note into spaces", () => {
		expect(
			validateFeedback(1, {
				findingId: "f",
				verdict: "rejected",
				note: "a\u0000b\u007fc\u{1F600}",
			})?.note,
		).toBe("a b c\u{1F600}");
	});

	it("gives the latest verdict per finding of the PR, skipping junk", () => {
		const file = path.join(project, FEEDBACK_RELATIVE_PATH);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(
			file,
			[
				JSON.stringify({ v: 1, pr: 3, finding_id: "a", verdict: "rejected" }),
				"not json",
				JSON.stringify({ v: 1, pr: 4, finding_id: "b", verdict: "rejected" }),
				JSON.stringify({ v: 1, pr: 3, finding_id: "a", verdict: "accepted" }),
				JSON.stringify({ v: 1, pr: 3, finding_id: "__proto__x", verdict: "nope" }),
				JSON.stringify({ v: 2, pr: 3, finding_id: "c", verdict: "rejected" }),
			].join("\n"),
		);
		expect(readFeedback(project, 3)).toEqual({ a: "accepted" });
	});
});
