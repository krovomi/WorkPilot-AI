/**
 * The saved run (#358, lot 2): written atomically in the project's own
 * `.workpilot/`, links refused, read back only when it is whole and coherent
 * with the project's tasks.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WaveRunState } from "../../../shared/types/conflict-waves";
import { clearSavedRun, RUN_FILE, readSavedRun, validateRunState, writeSavedRun } from "../run-store";

const PROJECT_ID = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const NOW = new Date("2026-11-16T09:30:00.000Z");
const KNOWN = new Set(["001-a", "002-b", "003-c"]);

const STATE: WaveRunState = {
	projectId: PROJECT_ID,
	waves: [["001-a", "002-b"], ["003-c"]],
	current: 1,
	advanceWhen: "merged",
	maxParallel: 2,
	started: ["001-a", "002-b"],
};

let root: string;
let project: string;
const runFile = () => path.join(project, ".workpilot", RUN_FILE);

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "wave-run-"));
	project = path.join(root, "project");
	mkdirSync(project);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("validateRunState", () => {
	it("keeps a coherent state and nothing else it was sent", () => {
		expect(validateRunState({ ...STATE, extra: "x", path: "/etc" }, PROJECT_ID)).toEqual(STATE);
		// Once the last wave settled, `current` equals the number of waves.
		expect(validateRunState({ ...STATE, current: 2 }, PROJECT_ID)).not.toBeNull();
	});

	it.each([
		["not an object", "x"],
		["another project", { ...STATE, projectId: "other" }],
		["no waves", { ...STATE, waves: [] }],
		["waves not a list", { ...STATE, waves: "001-a" }],
		["an empty wave", { ...STATE, waves: [["001-a"], []] }],
		["a path as task id", { ...STATE, waves: [["../../etc"]], started: [] }],
		["a task twice", { ...STATE, waves: [["001-a"], ["001-a"]], started: [] }],
		["too many waves", { ...STATE, waves: Array.from({ length: 201 }, (_, i) => [`t${i}`]), started: [] }],
		["too many tasks", { ...STATE, waves: [Array.from({ length: 201 }, (_, i) => `t${i}`)], started: [] }],
		["a negative wave", { ...STATE, current: -1 }],
		["a wave past the end", { ...STATE, current: 3 }],
		["a fractional wave", { ...STATE, current: 0.5 }],
		["an unknown advance rule", { ...STATE, advanceWhen: "never" }],
		["no parallelism", { ...STATE, maxParallel: 0 }],
		["a huge parallelism", { ...STATE, maxParallel: 1000 }],
		["started not a list", { ...STATE, started: "001-a" }],
		["a started task outside the waves", { ...STATE, started: ["009-z"] }],
		["a task started twice", { ...STATE, started: ["001-a", "001-a"] }],
	])("refuses %s", (_name, raw) => {
		expect(validateRunState(raw, PROJECT_ID)).toBeNull();
	});

	it("refuses an ill-formed project id even when both sides agree", () => {
		expect(validateRunState({ ...STATE, projectId: "../x" }, "../x")).toBeNull();
	});
});

describe("writeSavedRun / readSavedRun", () => {
	it("round-trips a run, stamped with the time it was saved, and leaves no temporary file", () => {
		writeSavedRun(project, STATE, NOW);
		expect(readSavedRun(project, PROJECT_ID, KNOWN)).toEqual({
			run: { ...STATE, savedAt: NOW.toISOString() },
			ignored: false,
		});
		expect(readdirSync(path.join(project, ".workpilot"))).toEqual([RUN_FILE]);
		// Overwritten in place on the next save.
		writeSavedRun(project, { ...STATE, current: 0 }, NOW);
		expect(readSavedRun(project, PROJECT_ID, KNOWN).run?.current).toBe(0);
	});

	it("writes the file for its owner only", () => {
		writeSavedRun(project, STATE, NOW);
		// POSIX permissions: Windows reports its own bits, the content check stands.
		if (path.sep === "/") expect(statSync(runFile()).mode & 0o077).toBe(0);
		expect(JSON.parse(readFileSync(runFile(), "utf-8"))).toMatchObject({ version: 1, current: 1 });
	});

	it("has nothing to resume in a project that never ran", () => {
		expect(readSavedRun(project, PROJECT_ID, KNOWN)).toEqual({ run: null, ignored: false });
		mkdirSync(path.join(project, ".workpilot"));
		expect(readSavedRun(project, PROJECT_ID, KNOWN)).toEqual({ run: null, ignored: false });
	});

	it.each([
		["not JSON", "{"],
		["another version", JSON.stringify({ ...STATE, version: 2, savedAt: NOW.toISOString() })],
		["no date", JSON.stringify({ ...STATE, version: 1 })],
		["a bad date", JSON.stringify({ ...STATE, version: 1, savedAt: "yesterday" })],
		["an array", "[]"],
		["another project's run", JSON.stringify({ ...STATE, projectId: "other", version: 1, savedAt: NOW.toISOString() })],
		[
			"a task the project no longer has",
			JSON.stringify({ ...STATE, waves: [["001-a"], ["099-gone"]], started: [], version: 1, savedAt: NOW.toISOString() }),
		],
		["an oversized file", JSON.stringify({ ...STATE, version: 1, savedAt: NOW.toISOString(), pad: "x".repeat(300_000) })],
	])("ignores %s", (_name, content) => {
		mkdirSync(path.join(project, ".workpilot"));
		writeFileSync(runFile(), content);
		expect(readSavedRun(project, PROJECT_ID, KNOWN)).toEqual({ run: null, ignored: true });
	});

	it("ignores a run file that is a folder", () => {
		mkdirSync(runFile(), { recursive: true });
		expect(readSavedRun(project, PROJECT_ID, KNOWN)).toEqual({ run: null, ignored: true });
	});

	it("refuses a linked run file, to read or to write", () => {
		const elsewhere = path.join(root, "elsewhere.json");
		writeFileSync(elsewhere, JSON.stringify({ ...STATE, version: 1, savedAt: NOW.toISOString() }));
		mkdirSync(path.join(project, ".workpilot"));
		symlinkSync(elsewhere, runFile());
		expect(readSavedRun(project, PROJECT_ID, KNOWN)).toEqual({ run: null, ignored: true });
		expect(() => writeSavedRun(project, STATE, NOW)).toThrow(/linked run file/);
		expect(readFileSync(elsewhere, "utf-8")).toContain('"version":1');
	});

	it("refuses a linked .workpilot folder, to read, write or clear", () => {
		const outside = path.join(root, "outside");
		mkdirSync(outside);
		writeFileSync(path.join(outside, RUN_FILE), JSON.stringify({ ...STATE, version: 1, savedAt: NOW.toISOString() }));
		symlinkSync(outside, path.join(project, ".workpilot"), "junction");
		expect(readSavedRun(project, PROJECT_ID, KNOWN)).toEqual({ run: null, ignored: true });
		expect(() => writeSavedRun(project, STATE, NOW)).toThrow(/linked or non-folder/);
		expect(() => clearSavedRun(project)).toThrow(/linked or non-folder/);
		expect(readdirSync(outside)).toEqual([RUN_FILE]);
	});

	it("refuses a .workpilot that is a file", () => {
		writeFileSync(path.join(project, ".workpilot"), "x");
		expect(() => writeSavedRun(project, STATE, NOW)).toThrow(/non-folder/);
	});

	it("resolves a project reached through a link to its real folder", () => {
		const alias = path.join(root, "alias");
		symlinkSync(project, alias, "junction");
		writeSavedRun(alias, STATE, NOW);
		expect(readSavedRun(project, PROJECT_ID, KNOWN).run?.current).toBe(1);
	});

	it("refuses a .workpilot that resolves outside the project (swapped after the check)", () => {
		const real = fs.realpathSync;
		const spy = vi.spyOn(fs, "realpathSync").mockImplementation(((p: fs.PathLike) =>
			String(p).endsWith(".workpilot") ? path.join(root, "elsewhere") : real(p)) as typeof fs.realpathSync);
		try {
			expect(() => writeSavedRun(project, STATE, NOW)).toThrow(/outside the project/);
		} finally {
			spy.mockRestore();
		}
	});

	it("gives up on a project path that is a file", () => {
		const file = path.join(root, "not-a-folder");
		writeFileSync(file, "x");
		expect(readSavedRun(file, PROJECT_ID, KNOWN)).toEqual({ run: null, ignored: true });
		expect(() => writeSavedRun(file, STATE, NOW)).toThrow();
	});

	it("throws on a missing project folder rather than writing elsewhere", () => {
		expect(() => writeSavedRun(path.join(root, "missing"), STATE, NOW)).toThrow();
	});

	it("removes its temporary file when the rename fails", () => {
		// A folder where the file goes: the rename fails, nothing is left behind.
		mkdirSync(path.join(runFile(), "inside"), { recursive: true });
		expect(() => writeSavedRun(project, STATE, NOW)).toThrow();
		expect(readdirSync(path.join(project, ".workpilot"))).toEqual([RUN_FILE]);
	});
});

describe("clearSavedRun", () => {
	it("forgets a saved run, and does nothing when there is none", () => {
		clearSavedRun(project);
		writeSavedRun(project, STATE, NOW);
		clearSavedRun(project);
		expect(readSavedRun(project, PROJECT_ID, KNOWN)).toEqual({ run: null, ignored: false });
		clearSavedRun(project);
	});

	it("removes a linked run file itself, never its target", () => {
		const elsewhere = path.join(root, "keep.json");
		writeFileSync(elsewhere, "keep");
		mkdirSync(path.join(project, ".workpilot"));
		symlinkSync(elsewhere, runFile());
		clearSavedRun(project);
		expect(readFileSync(elsewhere, "utf-8")).toBe("keep");
		expect(readdirSync(path.join(project, ".workpilot"))).toEqual([]);
	});
});
