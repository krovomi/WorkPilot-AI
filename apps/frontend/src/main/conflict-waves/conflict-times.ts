/**
 * When a task's merge conflict appeared and when it was resolved (#358,
 * lot 4), for the sprint metrics: `<project>/.workpilot/merge-conflict-times.json`,
 * newest first, at most `MAX_ENTRIES` conflicts.
 *
 * The merge flow writes it from the main process's clock: a merge, or its
 * preview, that reports a git conflict opens an entry for the task (one open
 * entry per task); the task's next merge that succeeds closes it. Two dates
 * that were seen, never an estimate. The file goes through the same folder
 * checks, bounded read and atomic write as the saved run (`run-store.ts`);
 * a file that cannot be read starts again, and the view says so.
 */

import path from "node:path";
import type { MergeConflictTime, MergeConflictTimes } from "../../shared/types/conflict-waves";
import { TASK_ID } from "./plan-service";
import { isRecord, readBounded, workpilotDir, writeAtomically } from "./run-store";

export const CONFLICT_TIMES_FILE = "merge-conflict-times.json";
const CONFLICT_TIMES_VERSION = 1;
export const MAX_ENTRIES = 200;
const MAX_CONFLICT_TIMES_BYTES = 64 * 1024;

function isoOf(value: unknown): string | null {
	return typeof value === "string" && !Number.isNaN(Date.parse(value))
		? new Date(value).toISOString()
		: null;
}

/** An entry read back, rebuilt field by field, or null. */
export function validateConflictTime(raw: unknown): MergeConflictTime | null {
	if (!isRecord(raw)) return null;
	const { taskId } = raw;
	if (typeof taskId !== "string" || !TASK_ID.test(taskId)) return null;
	const detectedAt = isoOf(raw.detectedAt);
	if (!detectedAt) return null;
	if (raw.resolvedAt === null) return { taskId, detectedAt, resolvedAt: null };
	const resolvedAt = isoOf(raw.resolvedAt);
	if (!resolvedAt || Date.parse(resolvedAt) < Date.parse(detectedAt)) return null;
	return { taskId, detectedAt, resolvedAt };
}

export function readConflictTimes(projectPath: string): MergeConflictTimes {
	let text: string;
	try {
		const dir = workpilotDir(projectPath, false);
		if (!dir) return { entries: [], ignored: false };
		text = readBounded(path.join(dir, CONFLICT_TIMES_FILE), MAX_CONFLICT_TIMES_BYTES);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], ignored: false };
		return { entries: [], ignored: true };
	}
	try {
		const raw: unknown = JSON.parse(text);
		if (!isRecord(raw) || raw.version !== CONFLICT_TIMES_VERSION || !Array.isArray(raw.entries)) {
			throw new Error("version");
		}
		const entries = raw.entries.slice(0, MAX_ENTRIES).map(validateConflictTime);
		if (entries.some((e) => e === null)) throw new Error("entry");
		return { entries: entries as MergeConflictTime[], ignored: false };
	} catch {
		return { entries: [], ignored: true };
	}
}

function write(projectPath: string, entries: MergeConflictTime[]): void {
	writeAtomically(
		projectPath,
		CONFLICT_TIMES_FILE,
		JSON.stringify({ version: CONFLICT_TIMES_VERSION, entries: entries.slice(0, MAX_ENTRIES) }),
	);
}

/** A conflict seen now on a task's merge: opens an entry unless one is open already. */
export function noteMergeConflict(projectPath: string, taskId: string, now: Date): void {
	if (!TASK_ID.test(taskId)) return;
	const { entries } = readConflictTimes(projectPath);
	if (entries.some((e) => e.taskId === taskId && e.resolvedAt === null)) return;
	write(projectPath, [{ taskId, detectedAt: now.toISOString(), resolvedAt: null }, ...entries]);
}

/** A task's merge that succeeded now: closes its open entry, if it has one. */
export function noteMergeSucceeded(projectPath: string, taskId: string, now: Date): void {
	const { entries } = readConflictTimes(projectPath);
	const open = entries.findIndex((e) => e.taskId === taskId && e.resolvedAt === null);
	if (open < 0) return;
	const resolvedAt = new Date(Math.max(now.getTime(), Date.parse(entries[open].detectedAt))).toISOString();
	write(
		projectPath,
		entries.map((e, index) => (index === open ? { ...e, resolvedAt } : e)),
	);
}

/**
 * Records a merge outcome for a task, never failing the merge it follows:
 * a refused folder or file is logged and left as it is.
 */
export function recordMergeOutcome(
	projectPath: string,
	taskId: string,
	outcome: "conflict" | "merged",
	now: Date = new Date(),
): void {
	try {
		if (outcome === "conflict") noteMergeConflict(projectPath, taskId, now);
		else noteMergeSucceeded(projectPath, taskId, now);
	} catch (error) {
		console.error("[merge] recording the conflict time failed:", error);
	}
}
