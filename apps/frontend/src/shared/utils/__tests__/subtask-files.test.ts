/**
 * Tests for extractSubtaskFiles().
 *
 * Regression guard for the per-subtask "files modified" view that was always
 * empty: the planner writes `files_to_modify` / `files_to_create`, but the UI
 * model only read a flat `files` field that never existed in the plan.
 */

import { describe, expect, it } from "vitest";

import { extractSubtaskFiles } from "../subtask-files";

describe("extractSubtaskFiles", () => {
	it("reads files_to_modify from the planner output", () => {
		expect(
			extractSubtaskFiles({ files_to_modify: ["src/a.ts", "src/b.ts"] }),
		).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("reads files_to_create from the planner output", () => {
		expect(
			extractSubtaskFiles({ files_to_create: ["src/new.ts"] }),
		).toEqual(["src/new.ts"]);
	});

	it("merges modify and create entries, modify first", () => {
		expect(
			extractSubtaskFiles({
				files_to_modify: ["src/a.ts"],
				files_to_create: ["src/b.ts"],
			}),
		).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("de-duplicates files appearing in multiple fields", () => {
		expect(
			extractSubtaskFiles({
				files_to_modify: ["src/a.ts"],
				files_to_create: ["src/a.ts", "src/b.ts"],
				files: ["src/a.ts"],
			}),
		).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("falls back to the legacy flat files field", () => {
		expect(extractSubtaskFiles({ files: ["legacy.ts"] })).toEqual([
			"legacy.ts",
		]);
	});

	it("returns an empty array when no file fields are present", () => {
		expect(extractSubtaskFiles({})).toEqual([]);
	});

	it("ignores non-array and non-string values defensively", () => {
		expect(
			extractSubtaskFiles({
				files_to_modify: "src/a.ts" as unknown as string[],
				files_to_create: [42, "src/b.ts"] as unknown as string[],
				files: null as unknown as string[],
			}),
		).toEqual(["src/b.ts"]);
	});
});
