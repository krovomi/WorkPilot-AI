/**
 * A generated-code card's log: what a page run did, in the card's
 * task_logs.json, in the shape every log view already reads.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appendReviewRunLog, MAX_RUN_LOG_LINES } from "../review-log";

let specDir: string;
const read = () => JSON.parse(readFileSync(path.join(specDir, "task_logs.json"), "utf-8"));

beforeEach(() => {
	specDir = mkdtempSync(path.join(tmpdir(), "review-log-"));
});

describe("appendReviewRunLog", () => {
	it("keeps the planning and validation phases of an existing log", () => {
		writeFileSync(
			path.join(specDir, "task_logs.json"),
			JSON.stringify({
				spec_id: "001-a",
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
				phases: {
					planning: { phase: "planning", status: "completed", started_at: null, completed_at: null, entries: [{ type: "text", content: "plan" }] },
				},
			}),
			"utf-8",
		);
		expect(
			appendReviewRunLog({
				specDir,
				specId: "001-a",
				summary: "Unit tests for a.py",
				commitMessage: "test: add generated unit tests for a.py",
				files: [],
				language: "en",
				now: new Date("2026-11-14T10:00:00Z"),
			}),
		).toBe(true);
		const logs = read();
		expect(logs.created_at).toBe("2026-01-01T00:00:00.000Z");
		expect(logs.phases.planning.entries).toHaveLength(1);
		expect(logs.phases.validation.entries).toEqual([]);
		expect(logs.phases.coding.entries.map((e: { content: string }) => e.content)).toEqual([
			"Unit tests for a.py",
			"No file changed",
			"Commit: test: add generated unit tests for a.py",
			"Unit tests for a.py",
		]);
		expect(logs.phases.coding.started_at).toBe("2026-11-14T10:00:00.000Z");
	});

	it("bounds a run's lines and drops blank ones", () => {
		const lines = ["", "  ", ...Array.from({ length: MAX_RUN_LOG_LINES + 50 }, (_, i) => `line ${i}`)];
		appendReviewRunLog({ specDir, specId: "x", summary: "s", commitMessage: "m", files: [], lines, language: "fr" });
		const texts = read().phases.coding.entries.filter((e: { type: string }) => e.type === "text");
		expect(texts).toHaveLength(MAX_RUN_LOG_LINES);
		expect(texts[0].content).toBe("line 50");
	});

	it("starts over from a log it cannot read, rather than failing the run", () => {
		writeFileSync(path.join(specDir, "task_logs.json"), "{not json", "utf-8");
		expect(
			appendReviewRunLog({ specDir, specId: "x", summary: "s", commitMessage: "m", files: ["a"], language: "fr" }),
		).toBe(true);
		expect(read().phases.coding.entries).toHaveLength(4);
	});

	it("reports a log it could not write instead of throwing", () => {
		expect(
			appendReviewRunLog({
				specDir: path.join(specDir, "missing", "dir"),
				specId: "x",
				summary: "s",
				commitMessage: "m",
				files: [],
				language: "en",
			}),
		).toBe(false);
	});
});
