/**
 * A duplicated "Create toto.txt" task, edited to ask for tata.txt, ran on the
 * copied spec and QA deleted tata.txt. Editing the description of a task that
 * has not run must discard what was derived from the old one.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DESCRIPTION_DERIVED_FILES,
	discardDescriptionDerivedFiles,
	specIsStale,
} from "../stale-spec";

describe("specIsStale", () => {
	it("is stale when a backlog task's description changes", () => {
		expect(
			specIsStale(
				"backlog",
				'Créer un fichier "toto.txt"',
				'Créer un fichier "tata.txt"',
			),
		).toBe(true);
	});

	it("ignores whitespace-only edits", () => {
		expect(specIsStale("backlog", "Create toto.txt\n", "  Create toto.txt")).toBe(
			false,
		);
	});

	it("keeps the spec of a task that already ran", () => {
		expect(specIsStale("human_review", "toto", "tata")).toBe(false);
		expect(specIsStale("in_progress", "toto", "tata")).toBe(false);
	});

	it("treats a missing previous description as a change", () => {
		expect(specIsStale("backlog", undefined, "tata")).toBe(true);
	});
});

describe("discardDescriptionDerivedFiles", () => {
	let specDir: string;

	beforeEach(() => {
		specDir = mkdtempSync(path.join(tmpdir(), "wp-stale-spec-"));
	});

	afterEach(() => {
		rmSync(specDir, { recursive: true, force: true });
	});

	it("removes the spec and what was derived with it, keeps the rest", () => {
		for (const name of DESCRIPTION_DERIVED_FILES) {
			writeFileSync(path.join(specDir, name), "x", "utf-8");
		}
		writeFileSync(path.join(specDir, "requirements.json"), "{}", "utf-8");
		writeFileSync(path.join(specDir, "task_metadata.json"), "{}", "utf-8");
		writeFileSync(path.join(specDir, "implementation_plan.json"), "{}", "utf-8");

		const removed = discardDescriptionDerivedFiles(specDir);

		expect(removed.sort()).toEqual([...DESCRIPTION_DERIVED_FILES].sort());
		expect(existsSync(path.join(specDir, "spec.md"))).toBe(false);
		expect(existsSync(path.join(specDir, "requirements.json"))).toBe(true);
		expect(existsSync(path.join(specDir, "task_metadata.json"))).toBe(true);
		expect(existsSync(path.join(specDir, "implementation_plan.json"))).toBe(
			true,
		);
	});

	it("does nothing when no spec was written yet", () => {
		expect(discardDescriptionDerivedFiles(specDir)).toEqual([]);
	});
});
