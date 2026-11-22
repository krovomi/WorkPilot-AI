/**
 * Execution waves of a server project (Conflict Predictor, #358), for the
 * desktop app in server mode. A server project has no worktree here: the
 * server plans its backlog from its clone and runs "Execute in optimal order"
 * itself (`apps/backend/shared_features/execution_waves.py`), the routes the
 * mobile app's Waves page reads. The app sends a project id, never a path,
 * through `authedFetch`, as the person signed in; the server checks every
 * permission again (rule S5).
 *
 * What the server answers is rebuilt here field by field, bounded, with
 * closed lists for every enum and task ids of the shape the planner accepts:
 * the renderer only ever sees what these functions build.
 */

import { TASK_STATUS_LABELS } from "../../shared/constants/task";
import type { IPCResult, Project } from "../../shared/types";
import type { ExecutionWave, WaveAdvanceWhen, WaveExclusion, WaveRunOutcome } from "../../shared/types/conflict-waves";
import type {
	ServerWaveCard,
	ServerWaveHistory,
	ServerWavePlan,
	ServerWavePlanTask,
	ServerWaveRun,
	ServerWaveRunAnswer,
	ServerWaveStartFailure,
} from "../../shared/types/server-conflict-waves";
import type { TaskStatus } from "../../shared/types/task";
import { authedFetch } from "../server-connection";
import { MAX_PARALLEL_CEILING, MAX_PLAN_TASKS, TASK_ID } from "./plan-service";

const MAX_TITLE = 300;
const MAX_DATE = 64;
const MAX_COUNT = 1_000_000;
const MAX_RISK = 1_000_000_000;
const MAX_DAYS = 366;
const UNEXPECTED = "Unexpected answer from the server";

export const ADVANCE_RULES: readonly WaveAdvanceWhen[] = ["merged", "review"];
const OUTCOMES: readonly WaveRunOutcome[] = ["done", "stopped"];
const START_FAILURES: readonly ServerWaveStartFailure[] = [
	"needs_approval",
	"claimed",
	"already_running",
	"quota",
	"refused",
	"missing",
];
const EXCLUSIONS: readonly WaveExclusion["reason"][] = ["cycle", "blocked_by_cycle"];
const COLUMNS = new Set(Object.keys(TASK_STATUS_LABELS));

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function oneOf<T extends string>(list: readonly T[], value: unknown): T | null {
	return (list as readonly unknown[]).includes(value) ? (value as T) : null;
}

function list(value: unknown, limit = MAX_PLAN_TASKS): unknown[] {
	return Array.isArray(value) ? value.slice(0, limit) : [];
}

function isTaskId(value: unknown): value is string {
	return typeof value === "string" && TASK_ID.test(value);
}

function taskIds(value: unknown): string[] {
	return list(value).filter(isTaskId);
}

/** A whole count, 0 when absent or not a number. */
function count(value: unknown, limit = MAX_COUNT): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.trunc(value), limit) : 0;
}

/** A score, as the planner sums it (it may carry decimals). */
function risk(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.min(Math.round(value * 100) / 100, MAX_RISK)
		: 0;
}

function text(value: unknown, limit: number): string | null {
	return typeof value === "string" && value ? value.slice(0, limit) : null;
}

function date(value: unknown): string | null {
	const at = text(value, MAX_DATE);
	return at && !Number.isNaN(Date.parse(at)) ? at : null;
}

function planTaskFrom(raw: unknown): ServerWavePlanTask | null {
	if (!isRecord(raw) || !isTaskId(raw.taskId)) return null;
	return {
		taskId: raw.taskId,
		title: text(raw.title, MAX_TITLE) ?? raw.taskId,
		planned: raw.planned === true,
		fileCount: count(raw.fileCount),
	};
}

function exclusionFrom(raw: unknown): WaveExclusion | null {
	if (!isRecord(raw) || !isTaskId(raw.taskId)) return null;
	const reason = oneOf(EXCLUSIONS, raw.reason);
	return reason ? { taskId: raw.taskId, reason } : null;
}

/** A wave, numbered once the empty ones are dropped. */
function waveFrom(raw: unknown): Omit<ExecutionWave, "index"> | null {
	if (!isRecord(raw)) return null;
	const ids = taskIds(raw.taskIds);
	return ids.length ? { taskIds: ids, residualRisk: risk(raw.residualRisk) } : null;
}

/** The server's plan, rebuilt; null when it is not one. */
export function planFrom(raw: unknown): ServerWavePlan | null {
	if (!isRecord(raw) || !Array.isArray(raw.waves)) return null;
	const merge = isRecord(raw.mergeChecks) ? raw.mergeChecks : {};
	const waves = list(raw.waves)
		.map(waveFrom)
		.filter((wave) => wave !== null)
		.map((wave, i) => ({ index: i + 1, ...wave }));
	return {
		maxParallel: Math.max(1, count(raw.maxParallel, MAX_PARALLEL_CEILING)),
		waves,
		tasks: list(raw.tasks)
			.map(planTaskFrom)
			.filter((task): task is ServerWavePlanTask => task !== null),
		excluded: list(raw.excluded)
			.map(exclusionFrom)
			.filter((e): e is WaveExclusion => e !== null),
		cycles: list(raw.cycles).filter(Array.isArray).length,
		totalRisk: risk(raw.totalRisk),
		residualRisk: risk(raw.residualRisk),
		mergeChecks: { checked: count(merge.checked), conflicts: count(merge.conflicts) },
	};
}

/** The server's run, rebuilt; null when it is not a coherent one. */
export function runFrom(raw: unknown): ServerWaveRun | null {
	if (!isRecord(raw)) return null;
	const advanceWhen = oneOf(ADVANCE_RULES, raw.advanceWhen);
	const waves = list(raw.waves)
		.map(taskIds)
		.filter((wave) => wave.length > 0);
	if (!advanceWhen || waves.length === 0) return null;
	const inRun = new Set(waves.flat());
	const failures: Record<string, ServerWaveStartFailure> = {};
	if (isRecord(raw.failures)) {
		for (const [id, reason] of Object.entries(raw.failures)) {
			const known = oneOf(START_FAILURES, reason);
			if (known && inRun.has(id)) failures[id] = known;
		}
	}
	return {
		waves,
		current: Math.min(count(raw.current), waves.length),
		advanceWhen,
		maxParallel: Math.max(1, count(raw.maxParallel, MAX_PARALLEL_CEILING)),
		started: taskIds(raw.started).filter((id) => inRun.has(id)),
		failures,
		savedAt: date(raw.savedAt),
	};
}

function cardFrom(raw: unknown): ServerWaveCard | null {
	if (!isRecord(raw) || !isTaskId(raw.id)) return null;
	return {
		id: raw.id,
		title: text(raw.title, MAX_TITLE) ?? raw.id,
		column: typeof raw.column === "string" && COLUMNS.has(raw.column) ? (raw.column as TaskStatus) : null,
		running: raw.running === true,
	};
}

/** An answer of the run routes, rebuilt; null when it is not one. */
export function runAnswerFrom(raw: unknown): ServerWaveRunAnswer | null {
	if (!isRecord(raw)) return null;
	const run = raw.run === null || raw.run === undefined ? null : runFrom(raw.run);
	if (raw.run && !run) return null;
	return {
		run,
		cards: run
			? list(raw.cards)
					.map(cardFrom)
					.filter((card): card is ServerWaveCard => card !== null)
			: [],
		blocked: run ? taskIds(raw.blocked) : [],
		ended: oneOf(OUTCOMES, raw.ended),
		ignored: raw.ignored === true,
	};
}

/** The history's figures, rebuilt; null when they are not there. */
export function historyFrom(raw: unknown): ServerWaveHistory | null {
	if (!isRecord(raw) || !isRecord(raw.summary)) return null;
	const summary = raw.summary;
	const conflicts = isRecord(raw.conflicts) ? raw.conflicts : { ignored: true };
	const median = conflicts.medianSeconds;
	return {
		ignored: raw.ignored === true,
		summary: {
			days: Math.max(1, count(summary.days, MAX_DAYS)),
			runs: count(summary.runs),
			stopped: count(summary.stopped),
			conflictsAvoided: count(summary.conflictsAvoided),
			riskAvoided: risk(summary.riskAvoided),
			started: count(summary.started),
			lastFinishedAt: date(summary.lastFinishedAt),
		},
		conflicts: {
			ignored: conflicts.ignored === true,
			resolved: count(conflicts.resolved),
			medianSeconds: typeof median === "number" && Number.isFinite(median) && median >= 0 ? median : null,
			open: count(conflicts.open),
		},
	};
}

const route = (project: Project, rest: string) =>
	`/api/features/execution-waves${rest}?project_id=${encodeURIComponent(project.id)}`;

async function ask<T>(
	project: Project,
	rest: string,
	method: string,
	rebuild: (raw: unknown) => T | null,
	body?: unknown,
): Promise<IPCResult<T>> {
	const answer = await authedFetch<unknown>(route(project, rest), method, body);
	if (!answer.ok) return { success: false, error: answer.error };
	const data = rebuild(answer.data);
	return data ? { success: true, data } : { success: false, error: UNEXPECTED };
}

/** The waves of the project's backlog, as the server plans them now. */
export function fetchServerWavePlan(project: Project): Promise<IPCResult<ServerWavePlan>> {
	return ask(project, "/plan", "GET", planFrom);
}

/** The run going on, if any, with each of its cards' column. */
export function fetchServerWaveRun(project: Project): Promise<IPCResult<ServerWaveRunAnswer>> {
	return ask(project, "/run", "GET", runAnswerFrom);
}

/** Plans the backlog and starts its first wave, as the person signed in. */
export async function startServerWaveRun(
	project: Project,
	advanceWhen: unknown,
): Promise<IPCResult<ServerWaveRunAnswer>> {
	const rule = oneOf(ADVANCE_RULES, advanceWhen);
	if (!rule) return { success: false, error: "advanceWhen must be merged or review" };
	return ask(project, "/run", "POST", runAnswerFrom, { advanceWhen: rule });
}

/** Starts what may start now, and the next wave once this one settled. */
export function stepServerWaveRun(project: Project): Promise<IPCResult<ServerWaveRunAnswer>> {
	return ask(project, "/run/step", "POST", runAnswerFrom);
}

/** Ends the run (recorded as stopped); the cards it started keep running. */
export function stopServerWaveRun(project: Project): Promise<IPCResult<ServerWaveRunAnswer>> {
	return ask(project, "/run", "DELETE", runAnswerFrom);
}

/** The last days of runs, counted, and of merge conflicts, timed. */
export function fetchServerWaveHistory(project: Project): Promise<IPCResult<ServerWaveHistory>> {
	return ask(project, "/history", "GET", historyFrom);
}
