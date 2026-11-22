/**
 * Merge conflict times (#358, lot 4), on real folders: a conflict opens one
 * entry per task, the next merge that goes through closes it, entries are
 * read back field by field and bounded, with the same folder and link
 * refusals as the saved run; a refusal never fails the merge it follows.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONFLICT_TIMES_FILE,
	MAX_ENTRIES,
	noteMergeConflict,
	noteMergeSucceeded,
	readConflictTimes,
	recordMergeOutcome,
	validateConflictTime,
} from "../conflict-times";

const T0 = new Date("2026-11-20T09:00:00.000Z");
const T1 = new Date("2026-11-20T11:30:00.000Z");

let root: string;
let project: string;
const timesFile = () => path.join(project, ".workpilot", CONFLICT_TIMES_FILE);

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "conflict-times-"));
	project = path.join(root, "project");
	mkdirSync(project);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("validateConflictTime", () => {
	const OPEN = { taskId: "001-a", detectedAt: T0.toISOString(), resolvedAt: null };

	it("keeps an open and a resolved entry, dates written the same way", () => {
		expect(validateConflictTime(OPEN)).toEqual(OPEN);
		expect(
			validateConflictTime({ taskId: "001-a", detectedAt: "2026-11-20T10:00:00+01:00", resolvedAt: T1.toISOString() }),
		).toEqual({ taskId: "001-a", detectedAt: T0.toISOString(), resolvedAt: T1.toISOString() });
	});

	it.each([
		["not an object", []],
		["a task id with a separator", { ...OPEN, taskId: "../x" }],
		["no task id", { ...OPEN, taskId: 3 }],
		["a bad detection date", { ...OPEN, detectedAt: "soon" }],
		["no detection date", { ...OPEN, detectedAt: undefined }],
		["a bad resolution date", { ...OPEN, resolvedAt: "later" }],
		["no resolution field", { taskId: "001-a", detectedAt: T0.toISOString() }],
		["a resolution before the conflict", { ...OPEN, detectedAt: T1.toISOString(), resolvedAt: T0.toISOString() }],
	])("refuses %s", (_name, raw) => {
		expect(validateConflictTime(raw)).toBeNull();
	});
});

describe("noteMergeConflict / noteMergeSucceeded / readConflictTimes", () => {
	it("has nothing in a project that never had a conflict, with or without a .workpilot folder", () => {
		expect(readConflictTimes(project)).toEqual({ entries: [], ignored: false });
		mkdirSync(path.join(project, ".workpilot"));
		expect(readConflictTimes(project)).toEqual({ entries: [], ignored: false });
	});

	it("opens one entry per task, closes it on the next merge, and a later conflict opens another", () => {
		noteMergeConflict(project, "001-a", T0);
		// The same conflict seen again (a second preview) keeps its first date.
		noteMergeConflict(project, "001-a", T1);
		noteMergeConflict(project, "002-b", T1);
		expect(readConflictTimes(project).entries).toEqual([
			{ taskId: "002-b", detectedAt: T1.toISOString(), resolvedAt: null },
			{ taskId: "001-a", detectedAt: T0.toISOString(), resolvedAt: null },
		]);

		noteMergeSucceeded(project, "001-a", T1);
		const later = new Date("2026-11-21T08:00:00.000Z");
		noteMergeConflict(project, "001-a", later);
		expect(readConflictTimes(project)).toEqual({
			entries: [
				{ taskId: "001-a", detectedAt: later.toISOString(), resolvedAt: null },
				{ taskId: "002-b", detectedAt: T1.toISOString(), resolvedAt: null },
				{ taskId: "001-a", detectedAt: T0.toISOString(), resolvedAt: T1.toISOString() },
			],
			ignored: false,
		});
	});

	it("writes nothing for a merge that had no conflict, nor for an ill-formed task id", () => {
		noteMergeSucceeded(project, "001-a", T1);
		noteMergeConflict(project, "../001-a", T0);
		expect(readConflictTimes(project)).toEqual({ entries: [], ignored: false });
		expect(() => readFileSync(timesFile())).toThrow();
	});

	it("never closes a conflict before it opened, when the clock went back", () => {
		noteMergeConflict(project, "001-a", T1);
		noteMergeSucceeded(project, "001-a", T0);
		expect(readConflictTimes(project).entries[0].resolvedAt).toBe(T1.toISOString());
	});

	it("keeps at most the limit, newest first", () => {
		for (let i = 0; i < MAX_ENTRIES + 3; i++) {
			noteMergeConflict(project, `t-${i}`, T0);
		}
		const { entries } = readConflictTimes(project);
		expect(entries).toHaveLength(MAX_ENTRIES);
		expect(entries[0].taskId).toBe(`t-${MAX_ENTRIES + 2}`);
	});

	it.each([
		["not JSON", "{"],
		["another version", JSON.stringify({ version: 2, entries: [] })],
		["entries not a list", JSON.stringify({ version: 1, entries: {} })],
		["an ill-formed entry", JSON.stringify({ version: 1, entries: [{ taskId: "x" }] })],
		["an oversized file", JSON.stringify({ version: 1, entries: [], pad: "x".repeat(80 * 1024) })],
	])("ignores a file that is %s, and starts again on the next conflict", (_name, body) => {
		mkdirSync(path.join(project, ".workpilot"));
		writeFileSync(timesFile(), body);
		expect(readConflictTimes(project)).toEqual({ entries: [], ignored: true });
		noteMergeConflict(project, "001-a", T0);
		expect(readConflictTimes(project)).toEqual({
			entries: [{ taskId: "001-a", detectedAt: T0.toISOString(), resolvedAt: null }],
			ignored: false,
		});
	});

	it("refuses a linked file, to read or to write", () => {
		const elsewhere = path.join(root, "elsewhere.json");
		const body = JSON.stringify({ version: 1, entries: [] });
		writeFileSync(elsewhere, body);
		mkdirSync(path.join(project, ".workpilot"));
		symlinkSync(elsewhere, timesFile());
		expect(readConflictTimes(project)).toEqual({ entries: [], ignored: true });
		expect(() => noteMergeConflict(project, "001-a", T0)).toThrow(/linked file/);
		expect(readFileSync(elsewhere, "utf-8")).toBe(body);
	});

	it("refuses a linked .workpilot folder", () => {
		const outside = path.join(root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, path.join(project, ".workpilot"), "junction");
		expect(readConflictTimes(project)).toEqual({ entries: [], ignored: true });
		expect(() => noteMergeConflict(project, "001-a", T0)).toThrow();
	});
});

describe("recordMergeOutcome", () => {
	it("records a conflict, then the merge that resolves it, on the main process's clock by default", () => {
		recordMergeOutcome(project, "001-a", "conflict", T0);
		recordMergeOutcome(project, "001-a", "merged");
		const [entry] = readConflictTimes(project).entries;
		expect(entry.detectedAt).toBe(T0.toISOString());
		expect(Date.parse(entry.resolvedAt as string)).toBeGreaterThan(T0.getTime());
	});

	it("logs a refused folder and lets the merge go on", () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const outside = path.join(root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, path.join(project, ".workpilot"), "junction");
		expect(() => recordMergeOutcome(project, "001-a", "conflict", T0)).not.toThrow();
		expect(logged).toHaveBeenCalledWith("[merge] recording the conflict time failed:", expect.any(Error));
	});
});
