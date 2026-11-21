/**
 * The run history (#358, lot 3), on real folders: records built from the
 * saved run, kept newest first and bounded, read back field by field, the
 * same folder and link refusals as the saved run.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SavedWaveRun, WaveRunRecord } from "../../../shared/types/conflict-waves";
import {
	appendRunRecord,
	HISTORY_FILE,
	isRunOutcome,
	MAX_RECORDS,
	readRunHistory,
	recordOf,
	validateRecord,
} from "../run-history";

const RECORD: WaveRunRecord = {
	finishedAt: "2026-11-16T09:30:00.000Z",
	outcome: "done",
	waves: 2,
	tasks: 3,
	started: 3,
	conflictsAvoided: 2,
	riskAvoided: 5,
};

let root: string;
let project: string;
const historyFile = () => path.join(project, ".workpilot", HISTORY_FILE);

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "wave-history-"));
	project = path.join(root, "project");
	mkdirSync(project);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("recordOf", () => {
	const RUN: SavedWaveRun = {
		projectId: "p1",
		waves: [["001-a", "002-b"], ["003-c"]],
		current: 2,
		advanceWhen: "merged",
		maxParallel: 2,
		started: ["001-a", "002-b", "003-c"],
		avoided: { conflicts: 2, risk: 5 },
		savedAt: "2026-11-16T09:00:00.000Z",
	};

	it("counts the saved run, stamped by the main process's clock", () => {
		expect(recordOf(RUN, "done", new Date(RECORD.finishedAt))).toEqual(RECORD);
	});

	it("counts nothing avoided for a run saved without the counts", () => {
		const { avoided: _none, ...older } = RUN;
		expect(recordOf(older, "stopped", new Date(RECORD.finishedAt))).toMatchObject({
			outcome: "stopped",
			conflictsAvoided: 0,
			riskAvoided: 0,
		});
	});
});

describe("validateRecord", () => {
	it("rebuilds a record and nothing else it holds", () => {
		expect(validateRecord({ ...RECORD, path: "/etc" })).toEqual(RECORD);
	});

	it.each([
		["not an object", "x"],
		["no date", { ...RECORD, finishedAt: 3 }],
		["a date that is not one", { ...RECORD, finishedAt: "yesterday" }],
		["an unknown outcome", { ...RECORD, outcome: "abandoned" }],
		["a negative count", { ...RECORD, tasks: -1 }],
		["too many waves", { ...RECORD, waves: 201 }],
		["a fractional started count", { ...RECORD, started: 1.5 }],
		["a missing conflicts count", { ...RECORD, conflictsAvoided: undefined }],
		["a huge risk", { ...RECORD, riskAvoided: 2_000_000 }],
	])("refuses %s", (_name, raw) => {
		expect(validateRecord(raw)).toBeNull();
	});

	it("knows the outcomes of the closed list only", () => {
		expect(isRunOutcome("done")).toBe(true);
		expect(isRunOutcome("stopped")).toBe(true);
		expect(isRunOutcome("abandoned")).toBe(false);
		expect(isRunOutcome(1)).toBe(false);
	});
});

describe("appendRunRecord / readRunHistory", () => {
	it("has no history in a project that never ran, with or without a .workpilot folder", () => {
		expect(readRunHistory(project)).toEqual({ records: [], ignored: false });
		mkdirSync(path.join(project, ".workpilot"));
		expect(readRunHistory(project)).toEqual({ records: [], ignored: false });
	});

	it("keeps the newest first, at most the limit", () => {
		appendRunRecord(project, RECORD);
		appendRunRecord(project, { ...RECORD, outcome: "stopped", finishedAt: "2026-11-17T10:00:00.000Z" });
		const history = readRunHistory(project);
		expect(history.ignored).toBe(false);
		expect(history.records.map((r) => r.outcome)).toEqual(["stopped", "done"]);

		for (let i = 0; i < MAX_RECORDS; i++) appendRunRecord(project, RECORD);
		expect(readRunHistory(project).records).toHaveLength(MAX_RECORDS);
	});

	it.each([
		["not JSON", "{"],
		["another version", JSON.stringify({ version: 2, records: [] })],
		["records not a list", JSON.stringify({ version: 1, records: {} })],
		["an ill-formed record", JSON.stringify({ version: 1, records: [{ ...RECORD, outcome: "x" }] })],
		["an oversized file", JSON.stringify({ version: 1, records: [], pad: "x".repeat(200 * 1024) })],
	])("ignores a history file that is %s, and starts again on the next run", (_name, body) => {
		mkdirSync(path.join(project, ".workpilot"));
		writeFileSync(historyFile(), body);
		expect(readRunHistory(project)).toEqual({ records: [], ignored: true });
		appendRunRecord(project, RECORD);
		expect(readRunHistory(project)).toEqual({ records: [RECORD], ignored: false });
	});

	it("refuses a linked history file, to read or to write", () => {
		const elsewhere = path.join(root, "elsewhere.json");
		writeFileSync(elsewhere, JSON.stringify({ version: 1, records: [RECORD] }));
		mkdirSync(path.join(project, ".workpilot"));
		symlinkSync(elsewhere, historyFile());
		expect(readRunHistory(project)).toEqual({ records: [], ignored: true });
		expect(() => appendRunRecord(project, RECORD)).toThrow(/linked file/);
		expect(JSON.parse(readFileSync(elsewhere, "utf-8")).records).toHaveLength(1);
	});

	it("refuses a linked .workpilot folder", () => {
		const outside = path.join(root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, path.join(project, ".workpilot"), "junction");
		expect(readRunHistory(project)).toEqual({ records: [], ignored: true });
		expect(() => appendRunRecord(project, RECORD)).toThrow();
	});
});
