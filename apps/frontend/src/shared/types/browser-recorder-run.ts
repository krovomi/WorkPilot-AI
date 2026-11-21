/**
 * A recorded test, once proposed on a review card, run there; and a
 * recording replayed without a window to see which selectors still work
 * (reshoot) (#387).
 *
 * Both come from the recorder runner: its output is read through the bounds
 * below, and the test's output is shown as text.
 */
import { parseSelectors, type RecordedSelector } from "./browser-recorder";

export const RESHOOT_STATUSES = ["ok", "changed", "missing", "failed", "not-reached"] as const;
export type ReshootStatus = (typeof RESHOOT_STATUSES)[number];

const STEP_ID = /^s\d{1,6}$/;
const MAX_OUTPUT = 4000;
const MAX_STEPS = 300;

export interface RecordedTestRun {
	readonly passed: boolean;
	readonly exitCode: number | null;
	readonly durationMs: number;
	/** The end of what the test printed: text, never markup. */
	readonly output: string;
	/** How the worktree's recipe went (`ready`, `nothing-to-do`, `awaiting-approval`…). */
	readonly setup: string;
	/** This code had never run before. */
	readonly firstRun: boolean;
	/** Recorded tests of the project run at least once, and those that passed the first time. */
	readonly firstRuns: number;
	readonly firstPassed: number;
}

export interface ReshootStep {
	readonly id: string;
	readonly status: ReshootStatus;
	/** The selectors that find the element now (`changed` only). */
	readonly selectors?: readonly RecordedSelector[];
}

export interface RecorderRunOutcome {
	readonly success: boolean;
	readonly error?: string;
	readonly run?: RecordedTestRun;
}

export interface ReshootOutcome {
	readonly success: boolean;
	readonly error?: string;
	readonly steps?: readonly ReshootStep[];
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** The runner's `RECORDER_RUN` result, or null. */
export function parseTestRun(raw: unknown): RecordedTestRun | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.passed !== "boolean") return null;
	return {
		passed: r.passed,
		exitCode: typeof r.exitCode === "number" && Number.isSafeInteger(r.exitCode) ? r.exitCode : null,
		durationMs: count(r.durationMs),
		output: typeof r.output === "string" ? r.output.slice(-MAX_OUTPUT) : "",
		setup: typeof r.setup === "string" && /^[a-z-]{1,30}$/.test(r.setup) ? r.setup : "",
		firstRun: r.firstRun === true,
		firstRuns: count(r.firstRuns),
		firstPassed: Math.min(count(r.firstPassed), count(r.firstRuns)),
	};
}

/** The runner's `RECORDER_RESHOOT` steps, the malformed ones left out. */
export function parseReshoot(raw: unknown): ReshootStep[] {
	const steps = raw && typeof raw === "object" ? (raw as Record<string, unknown>).steps : null;
	if (!Array.isArray(steps)) return [];
	const shots: ReshootStep[] = [];
	for (const item of steps.slice(0, MAX_STEPS)) {
		const s = (item ?? {}) as Record<string, unknown>;
		if (typeof s.id !== "string" || !STEP_ID.test(s.id)) continue;
		if (typeof s.status !== "string" || !(RESHOOT_STATUSES as readonly string[]).includes(s.status)) continue;
		const status = s.status as ReshootStatus;
		const selectors = status === "changed" ? parseSelectors(s.selectors) : [];
		if (status === "changed" && !selectors.length) continue;
		shots.push({ id: s.id, status, ...(selectors.length && { selectors }) });
	}
	return shots;
}

export const ASSIST_SOURCES = ["model", "rules"] as const;

/** A name for the test and the proposed checks ranked, by a light model or by rules. */
export interface RecorderAssist {
	readonly name: string;
	readonly checks: readonly string[];
	readonly source: (typeof ASSIST_SOURCES)[number];
}

export interface RecorderAssistOutcome {
	readonly success: boolean;
	readonly error?: string;
	readonly assist?: RecorderAssist;
}

/** The runner's `RECORDER_ASSIST` answer, its checks among `known`, or null. */
export function parseAssist(raw: unknown, known: readonly string[]): RecorderAssist | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.name !== "string" || !(ASSIST_SOURCES as readonly string[]).includes(String(r.source))) return null;
	const checks = Array.isArray(r.checks) ? r.checks.filter((id): id is string => known.includes(String(id))) : [];
	return { name: r.name.slice(0, 80), checks: [...new Set(checks)], source: r.source as RecorderAssist["source"] };
}

/** Step ids the renderer asks to update from the last reshoot, or null (S6). */
export function readStepIds(raw: unknown): string[] | null {
	if (!Array.isArray(raw)) return null;
	return [...new Set(raw.filter((id): id is string => typeof id === "string" && STEP_ID.test(id)))].slice(
		0,
		MAX_STEPS,
	);
}
