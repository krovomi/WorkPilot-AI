/**
 * The files steering the backend's context-window manager are written to
 * every spec dir copy (main + worktree), atomically, without losing the rest
 * of task_metadata.json.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTaskEvent } from "../../../agent/task-event-parser";
import {
	CONTEXT_ACTION_FILE,
	mergeContextPolicyIntoSpecDirs,
	TASK_METADATA_FILE,
	writeContextActionMarker,
} from "../context-files";

let root: string;
let mainDir: string;
let worktreeDir: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "ctx-files-"));
	mainDir = path.join(root, "main", "001-task");
	worktreeDir = path.join(root, "wt", "001-task");
	mkdirSync(mainDir, { recursive: true });
	mkdirSync(worktreeDir, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const read = (file: string) => JSON.parse(readFileSync(file, "utf-8"));

describe("writeContextActionMarker", () => {
	it("writes the marker in every copy", () => {
		const now = new Date("2026-10-14T09:00:00.000Z");
		const outcome = writeContextActionMarker([mainDir, worktreeDir], "compact", now);
		expect(outcome.written).toEqual([mainDir, worktreeDir]);
		for (const dir of [mainDir, worktreeDir]) {
			expect(read(path.join(dir, CONTEXT_ACTION_FILE))).toEqual({
				action: "compact",
				phase: null,
				subtaskId: null,
				requestedAt: "2026-10-14T09:00:00.000Z",
			});
		}
	});

	it("reports a directory it could not write", () => {
		const outcome = writeContextActionMarker([path.join(root, "missing")], "clear");
		expect(outcome.written).toEqual([]);
		expect(outcome.failed).toHaveLength(1);
	});
});

describe("mergeContextPolicyIntoSpecDirs", () => {
	it("merges the policy into every existing metadata file, keeping the other keys", () => {
		writeFileSync(
			path.join(mainDir, TASK_METADATA_FILE),
			JSON.stringify({ sourceType: "manual", contextPolicy: { mode: "off" } }),
		);
		writeFileSync(
			path.join(worktreeDir, TASK_METADATA_FILE),
			JSON.stringify({ tddMode: true }),
		);
		const policy = { mode: "clear" as const, thresholdPct: 70, prepareHandoff: false };
		const outcome = mergeContextPolicyIntoSpecDirs([mainDir, worktreeDir], policy);
		expect(outcome.written).toEqual([mainDir, worktreeDir]);
		expect(read(path.join(mainDir, TASK_METADATA_FILE))).toEqual({
			sourceType: "manual",
			contextPolicy: policy,
		});
		expect(read(path.join(worktreeDir, TASK_METADATA_FILE))).toEqual({
			tddMode: true,
			contextPolicy: policy,
		});
	});

	it("does not create a partial metadata file next to a real one", () => {
		writeFileSync(path.join(mainDir, TASK_METADATA_FILE), JSON.stringify({ a: 1 }));
		const policy = { mode: "auto" as const, thresholdPct: 50, prepareHandoff: true };
		const outcome = mergeContextPolicyIntoSpecDirs([mainDir, worktreeDir], policy);
		expect(outcome.written).toEqual([mainDir]);
	});

	it("creates it in the first copy when none has one", () => {
		const policy = { mode: "compact" as const, thresholdPct: 40, prepareHandoff: true };
		const outcome = mergeContextPolicyIntoSpecDirs([mainDir, worktreeDir], policy);
		expect(outcome.written).toEqual([mainDir]);
		expect(read(path.join(mainDir, TASK_METADATA_FILE))).toEqual({ contextPolicy: policy });
	});
});

describe("context events on the stdout protocol", () => {
	it("parses with every field kept (the schema passes them through)", () => {
		const line =
			'__TASK_EVENT__:{"type":"CONTEXT_USAGE","taskId":"t1","sequence":12,"percent":48.5,"usedTokens":97000,"windowTokens":200000,"handoffState":"preparing"}';
		const event = parseTaskEvent(line);
		expect(event).toMatchObject({
			type: "CONTEXT_USAGE",
			sequence: 12,
			percent: 48.5,
			usedTokens: 97000,
			handoffState: "preparing",
		});
	});
});
