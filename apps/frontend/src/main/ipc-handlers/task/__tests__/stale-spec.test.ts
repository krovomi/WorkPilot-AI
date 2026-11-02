/**
 * A duplicated "Create toto.txt" task, edited to ask for tata.txt, ran on the
 * copied spec and QA deleted tata.txt. Editing the description of a task that
 * has not run must discard what was derived from the old one.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	copySpecSource,
	DESCRIPTION_DERIVED_FILES,
	discardDescriptionDerivedFiles,
	discardSpecIfStale,
	SPEC_SOURCE_FILE,
	specIsStale,
	specSourceIsStale,
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

describe("spec source record (launch-time check)", () => {
	let specDir: string;

	const write = (name: string, data: unknown) =>
		writeFileSync(path.join(specDir, name), JSON.stringify(data), "utf-8");

	beforeEach(() => {
		specDir = mkdtempSync(path.join(tmpdir(), "wp-spec-source-"));
		writeFileSync(path.join(specDir, "spec.md"), "# toto", "utf-8");
	});

	afterEach(() => {
		rmSync(specDir, { recursive: true, force: true });
	});

	it("regenerates a spec written for another description", () => {
		write(SPEC_SOURCE_FILE, { task_description: 'Créer "toto.txt"' });
		write("requirements.json", { task_description: 'Créer "tata.txt"' });

		expect(specSourceIsStale(specDir)).toBe(true);
		expect(discardSpecIfStale(specDir, 0)).toBe(true);
		expect(existsSync(path.join(specDir, "spec.md"))).toBe(false);
		expect(existsSync(path.join(specDir, SPEC_SOURCE_FILE))).toBe(false);
		expect(existsSync(path.join(specDir, "requirements.json"))).toBe(true);
	});

	it("keeps a spec whose description only changed in whitespace", () => {
		write(SPEC_SOURCE_FILE, { task_description: "Create toto.txt\n" });
		write("requirements.json", { task_description: "  Create   toto.txt" });

		expect(discardSpecIfStale(specDir, 0)).toBe(false);
		expect(existsSync(path.join(specDir, "spec.md"))).toBe(true);
	});

	it("trusts a spec with no record or no readable requirements", () => {
		write("requirements.json", { task_description: "tata" });
		expect(specSourceIsStale(specDir)).toBe(false);

		write(SPEC_SOURCE_FILE, { task_description: "toto" });
		writeFileSync(path.join(specDir, "requirements.json"), "{oops", "utf-8");
		expect(specSourceIsStale(specDir)).toBe(false);
	});

	it("never discards a spec that already has a plan", () => {
		write(SPEC_SOURCE_FILE, { task_description: "toto" });
		write("requirements.json", { task_description: "tata" });

		expect(discardSpecIfStale(specDir, 3)).toBe(false);
		expect(existsSync(path.join(specDir, "spec.md"))).toBe(true);
	});

	it("gives a duplicate the source's description as its record", () => {
		const copyDir = path.join(specDir, "copy");
		mkdirSync(copyDir);
		write("requirements.json", { task_description: "toto" });
		writeFileSync(path.join(copyDir, "spec.md"), "# toto", "utf-8");
		writeFileSync(
			path.join(copyDir, "requirements.json"),
			JSON.stringify({ task_description: "tata" }),
			"utf-8",
		);

		copySpecSource(specDir, copyDir);

		const record = JSON.parse(
			readFileSync(path.join(copyDir, SPEC_SOURCE_FILE), "utf-8"),
		);
		expect(record.task_description).toBe("toto");
		expect(specSourceIsStale(copyDir)).toBe(true);
	});

	it("records nothing for a duplicate without a spec", () => {
		const copyDir = path.join(specDir, "copy");
		mkdirSync(copyDir);
		write("requirements.json", { task_description: "toto" });

		copySpecSource(specDir, copyDir);

		expect(existsSync(path.join(copyDir, SPEC_SOURCE_FILE))).toBe(false);
	});
});
