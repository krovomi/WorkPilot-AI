/**
 * Run history of "Execute in optimal order" (#358, lot 3), for the sprint
 * metrics: `<project>/.workpilot/execution-waves-history.json`, newest first,
 * at most `MAX_RECORDS` runs.
 *
 * A record is built here, when a run ends, from the run saved in the project
 * (already validated against the project's tasks) and the main process's
 * clock: the renderer only says how the run ended, from a closed list.
 * Counts only: no duration is estimated. The file goes through the same
 * folder checks, bounded read and atomic write as the saved run
 * (`run-store.ts`); a file that cannot be read starts a new history, and the
 * view says the old one was ignored.
 */

import path from "node:path";
import type {
	SavedWaveRun,
	WaveRunHistory,
	WaveRunOutcome,
	WaveRunRecord,
} from "../../shared/types/conflict-waves";
import { MAX_PLAN_TASKS } from "./plan-service";
import { count, isRecord, readBounded, workpilotDir, writeAtomically } from "./run-store";

export const HISTORY_FILE = "execution-waves-history.json";
const HISTORY_VERSION = 1;
export const MAX_RECORDS = 100;
const MAX_HISTORY_BYTES = 128 * 1024;
const OUTCOMES: ReadonlySet<string> = new Set<WaveRunOutcome>(["done", "stopped"]);

export function isRunOutcome(value: unknown): value is WaveRunOutcome {
	return typeof value === "string" && OUTCOMES.has(value);
}

/** A record read back, rebuilt field by field, or null. */
export function validateRecord(raw: unknown): WaveRunRecord | null {
	if (!isRecord(raw)) return null;
	const { finishedAt, outcome } = raw;
	if (typeof finishedAt !== "string" || Number.isNaN(Date.parse(finishedAt))) return null;
	if (!isRunOutcome(outcome)) return null;
	const waves = count(raw.waves, MAX_PLAN_TASKS);
	const tasks = count(raw.tasks, MAX_PLAN_TASKS);
	const started = count(raw.started, MAX_PLAN_TASKS);
	const conflictsAvoided = count(raw.conflictsAvoided);
	const riskAvoided = count(raw.riskAvoided);
	if (
		waves === null ||
		tasks === null ||
		started === null ||
		conflictsAvoided === null ||
		riskAvoided === null
	) {
		return null;
	}
	return {
		finishedAt: new Date(finishedAt).toISOString(),
		outcome,
		waves,
		tasks,
		started,
		conflictsAvoided,
		riskAvoided,
	};
}

export function readRunHistory(projectPath: string): WaveRunHistory {
	let text: string;
	try {
		const dir = workpilotDir(projectPath, false);
		if (!dir) return { records: [], ignored: false };
		text = readBounded(path.join(dir, HISTORY_FILE), MAX_HISTORY_BYTES);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], ignored: false };
		return { records: [], ignored: true };
	}
	try {
		const raw: unknown = JSON.parse(text);
		if (!isRecord(raw) || raw.version !== HISTORY_VERSION || !Array.isArray(raw.records)) {
			throw new Error("version");
		}
		const records = raw.records.slice(0, MAX_RECORDS).map(validateRecord);
		if (records.some((r) => r === null)) throw new Error("record");
		return { records: records as WaveRunRecord[], ignored: false };
	} catch {
		return { records: [], ignored: true };
	}
}

/** The record of a saved run that ended now. */
export function recordOf(run: SavedWaveRun, outcome: WaveRunOutcome, now: Date): WaveRunRecord {
	return {
		finishedAt: now.toISOString(),
		outcome,
		waves: run.waves.length,
		tasks: run.waves.flat().length,
		started: run.started.length,
		conflictsAvoided: run.avoided?.conflicts ?? 0,
		riskAvoided: run.avoided?.risk ?? 0,
	};
}

/** Adds a record in front of the history (an unreadable one starts again). */
export function appendRunRecord(projectPath: string, record: WaveRunRecord): void {
	const records = [record, ...readRunHistory(projectPath).records].slice(0, MAX_RECORDS);
	writeAtomically(
		projectPath,
		HISTORY_FILE,
		JSON.stringify({ version: HISTORY_VERSION, records }),
	);
}
