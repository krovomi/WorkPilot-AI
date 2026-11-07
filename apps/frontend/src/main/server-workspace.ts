/**
 * The workspace views of a server project (server mode): its dashboard, its
 * analytics, its costs and the history of its sessions.
 *
 * On this computer these views read the project folder
 * (`ipc-handlers/cost-handlers.ts`). A server project's agents run on the
 * server, so the server computes them for the project, from its cards, runs,
 * jobs and the ledgers its agents keep in its clone
 * (`apps/backend/shared_features/workspace.py`); nothing is read on this
 * computer for it, and the app sends a project id, never a path.
 *
 * What the server sends is checked again here: numbers are finite and not
 * negative, labels are strings under a size, lists are cut.
 */

import type {
	CostSummary,
	DashboardSnapshot,
	IPCResult,
	Project,
	WorkspaceSession,
	WorkspaceSessionPhase,
} from "../shared/types";
import { authedFetch } from "./server-connection";

const MAX_KEYS = 200;
const MAX_LABEL = 200;
const MAX_ERROR = 2_000;
const MAX_SESSIONS = 500;
const MAX_PHASES = 50;
const UNEXPECTED = "Unexpected answer from the server";

/** The server's run and job statuses, in the words the view filters on. */
const STATUS_WORDS: Readonly<Record<string, string>> = {
	succeeded: "completed",
	failed: "failed",
	cancelled: "cancelled",
	running: "running",
	queued: "queued",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function amount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: 0;
}

/** A finite number, possibly negative (a trend). */
function signed(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function label(value: unknown, limit = MAX_LABEL): string | undefined {
	return typeof value === "string" && value.length > 0
		? value.slice(0, limit)
		: undefined;
}

function moment(value: unknown): string | undefined {
	const text = label(value, 64);
	return text && !Number.isNaN(Date.parse(text)) ? text : undefined;
}

/** A map of labels to amounts, as the views draw it. */
function amounts(value: unknown): Record<string, number> {
	const out: Record<string, number> = {};
	if (!isRecord(value)) return out;
	for (const [key, raw] of Object.entries(value).slice(0, MAX_KEYS)) {
		const name = label(key);
		if (name) out[name] = amount(raw);
	}
	return out;
}

function projectQuery(project: Project): string {
	return `?project_id=${encodeURIComponent(project.id)}`;
}

async function read(
	project: Project,
	route: string,
): Promise<IPCResult<Record<string, unknown>>> {
	const answer = await authedFetch<unknown>(
		`/api/features/workspace/${route}${projectQuery(project)}`,
		"GET",
	);
	if (!answer.ok) return { success: false, error: answer.error };
	if (!isRecord(answer.data)) return { success: false, error: UNEXPECTED };
	return { success: true, data: answer.data };
}

export function toCostSummary(raw: unknown): CostSummary | null {
	if (!isRecord(raw)) return null;
	return {
		total_cost: amount(raw.total_cost),
		cost_by_provider: amounts(raw.cost_by_provider),
		cost_by_model: amounts(raw.cost_by_model),
		total_tokens: amount(raw.total_tokens),
		tokens_input: amount(raw.tokens_input),
		tokens_output: amount(raw.tokens_output),
		period_days: Math.max(1, amount(raw.period_days)),
		daily_avg: amount(raw.daily_avg),
		trend_pct: signed(raw.trend_pct),
	};
}

export function toDashboardSnapshot(raw: unknown): DashboardSnapshot | null {
	if (!isRecord(raw)) return null;
	return {
		tasks_by_status: amounts(raw.tasks_by_status),
		avg_completion_by_complexity: amounts(raw.avg_completion_by_complexity),
		qa_first_pass_rate: Math.min(100, amount(raw.qa_first_pass_rate)),
		qa_avg_score: amount(raw.qa_avg_score),
		total_tokens: amount(raw.total_tokens),
		tokens_by_provider: amounts(raw.tokens_by_provider),
		total_cost: amount(raw.total_cost),
		cost_by_model: amounts(raw.cost_by_model),
		merge_auto_count: amount(raw.merge_auto_count),
		merge_manual_count: amount(raw.merge_manual_count),
	};
}

function toPhase(raw: unknown, status: string): WorkspaceSessionPhase | null {
	if (!isRecord(raw)) return null;
	const name = label(raw.name);
	if (!name) return null;
	return { name, status, tokens: amount(raw.tokens) };
}

/** A run or a job of the server, as the Session History view lists it. */
export function toSession(raw: unknown): WorkspaceSession | null {
	if (!isRecord(raw)) return null;
	const id = label(raw.id, 64);
	const startedAt = moment(raw.started_at);
	const kind = raw.kind === "run" || raw.kind === "job" ? raw.kind : null;
	if (!id || !startedAt || !kind) return null;
	const status = STATUS_WORDS[String(raw.status)] ?? "queued";
	const phase = label(raw.phase, 80);
	const spec = label(raw.spec);
	const session: WorkspaceSession = {
		session_id: id,
		kind,
		status,
		started_at: startedAt,
		task_title: spec ?? phase ?? id,
	};
	if (spec) session.task_id = spec;
	if (phase) session.phase = phase;
	const by = label(raw.started_by);
	if (by) session.started_by = by;
	const endedAt = moment(raw.finished_at);
	if (endedAt) session.ended_at = endedAt;
	if (typeof raw.duration_seconds === "number") {
		session.duration_seconds = Math.trunc(amount(raw.duration_seconds));
	}
	if (typeof raw.tokens === "number") session.tokens_used = amount(raw.tokens);
	if (typeof raw.cost === "number") session.cost = amount(raw.cost);
	const error = label(raw.error, MAX_ERROR);
	if (error) session.error = error;
	const phases = Array.isArray(raw.phases)
		? raw.phases
				.slice(0, MAX_PHASES)
				.map((entry) => toPhase(entry, status))
				.filter((entry): entry is WorkspaceSessionPhase => entry !== null)
		: [];
	if (phases.length > 0) session.phases = phases;
	return session;
}

/** What the project's agents spent over the last thirty days. */
export async function fetchServerCostSummary(
	project: Project,
): Promise<IPCResult<CostSummary>> {
	const answer = await read(project, "costs");
	if (!answer.success) return { success: false, error: answer.error };
	const summary = toCostSummary(answer.data?.summary);
	return summary
		? { success: true, data: summary }
		: { success: false, error: UNEXPECTED };
}

/** The project's dashboard: its cards by status, its spend, QA and merges. */
export async function fetchServerDashboard(
	project: Project,
): Promise<IPCResult<DashboardSnapshot>> {
	const answer = await read(project, "dashboard");
	if (!answer.success) return { success: false, error: answer.error };
	const snapshot = toDashboardSnapshot(answer.data?.snapshot);
	return snapshot
		? { success: true, data: snapshot }
		: { success: false, error: UNEXPECTED };
}

/** The project's runs and jobs, the latest first. */
export async function fetchServerSessions(
	project: Project,
): Promise<IPCResult<WorkspaceSession[]>> {
	const answer = await read(project, "sessions");
	if (!answer.success) return { success: false, error: answer.error };
	const rows = answer.data?.sessions;
	if (!Array.isArray(rows)) return { success: false, error: UNEXPECTED };
	return {
		success: true,
		data: rows
			.slice(0, MAX_SESSIONS)
			.map(toSession)
			.filter((row): row is WorkspaceSession => row !== null),
	};
}
