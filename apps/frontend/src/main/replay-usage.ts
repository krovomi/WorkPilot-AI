/**
 * How replays are shared (#347): counted where they live, sent nowhere.
 *
 * - On this machine, the local backend keeps a ledger of the exports the app
 *   actually produced (a kind and a time, nothing else) and reads its
 *   sessions (`apps/backend/replay/usage.py`). Main counts an export once the
 *   file is written or the link is made, never before the dialog closes.
 * - On a server project, that server computes its team links' aggregates
 *   for the project (`shared_features/replay_share_overview.py`).
 *
 * There is no telemetry: no figure leaves the machine, or the person's own
 * server. Each answer is checked here before the renderer sees it.
 */

import type {
	ReplayExportKind,
	ReplayTeamUsage,
	ReplayTeamUsageResult,
	ReplayUsage,
	ReplayUsageResult,
} from "../shared/types/replay-share";
import { REPLAY_EXPORT_KINDS } from "../shared/types/replay-share";
import { backendFetch } from "./ipc-handlers/_backend-fetch";
import { authedFetch, isServerMode } from "./server-connection";
import { getServerProject } from "./server-projects";

const MAX_WEEKS = 12;
const KINDS = new Set<string>(REPLAY_EXPORT_KINDS);

type Failure = { success: false; error: string; unreachable?: true };
const fail = (error: string): Failure => ({ success: false, error });

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number {
	return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function decimal(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function ratio(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
		? value
		: null;
}

/** An ISO date from seconds since the epoch (local) or an ISO string (server). */
function moment(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		const date = new Date(value * 1000);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}
	if (typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value))) {
		return value;
	}
	return null;
}

/** Each week read by `read` from its dates, or null when one is not a week. */
function weeksOf<T>(
	raw: unknown,
	read: (week: Record<string, unknown>, start: string, end: string) => T,
): T[] | null {
	if (!Array.isArray(raw)) return null;
	const weeks: T[] = [];
	for (const week of raw.slice(-MAX_WEEKS)) {
		const start = isRecord(week) ? moment(week.start) : null;
		const end = isRecord(week) ? moment(week.end) : null;
		if (!start || !end) return null;
		weeks.push(read(week as Record<string, unknown>, start, end));
	}
	return weeks;
}

/** The local backend's report, checked again, or null. */
export function toReplayUsage(raw: unknown): ReplayUsage | null {
	if (!isRecord(raw)) return null;
	const weeks = weeksOf(raw.weeks, (week, start, end) => {
		const kinds = isRecord(week.by_kind) ? week.by_kind : {};
		const byKind = Object.fromEntries(
			REPLAY_EXPORT_KINDS.map((kind) => [kind, count(kinds[kind])]),
		) as Record<ReplayExportKind, number>;
		return { start, end, total: count(week.total), byKind };
	});
	const sessions = isRecord(raw.sessions) ? raw.sessions : null;
	if (!weeks || !sessions) return null;
	return {
		weeks,
		exports: count(raw.exports),
		exportsPerWeek: decimal(raw.exports_per_week),
		sessions: {
			total: count(sessions.total),
			annotated: count(sessions.annotated),
			discussed: count(sessions.discussed),
			summarized: count(sessions.summarized),
			imported: count(sessions.imported),
		},
		annotatedRatio: ratio(raw.annotated_ratio),
	};
}

/** A server project's aggregates, checked again, or null. */
export function toTeamUsage(raw: unknown): ReplayTeamUsage | null {
	if (!isRecord(raw)) return null;
	const weeks = weeksOf(raw.weeks, (week, start, end) => ({
		start,
		end,
		created: count(week.created),
		opened: count(week.opened),
	}));
	if (!weeks) return null;
	return {
		windowDays: count(raw.window_days),
		weeks,
		links: count(raw.links),
		openedLinks: count(raw.opened_links),
		openRate: ratio(raw.open_rate),
		opens: count(raw.opens),
		active: count(raw.active),
		annotated: count(raw.annotated),
		annotatedRatio: ratio(raw.annotated_ratio),
		sharers: count(raw.sharers),
	};
}

/**
 * Count one export on this machine. Counting never stands in the way of the
 * export itself: a backend that does not answer leaves it uncounted.
 */
export async function recordReplayExport(kind: ReplayExportKind): Promise<void> {
	if (!KINDS.has(kind)) return;
	await backendFetch("/replay/usage/exports", {
		method: "POST",
		body: JSON.stringify({ kind }),
	});
}

export async function getReplayUsage(): Promise<ReplayUsageResult> {
	const answer = await backendFetch<Record<string, unknown>>("/replay/usage");
	if (!answer.success) return answer;
	const usage = toReplayUsage(answer);
	return usage ? { success: true, usage } : fail("bad_usage");
}

export async function getTeamReplayUsage(projectId: unknown): Promise<ReplayTeamUsageResult> {
	const project = getServerProject(projectId);
	if (!project || !isServerMode()) return fail("not_a_server_project");
	const answer = await authedFetch<unknown>(
		`/api/features/replay-shares/usage?project_id=${encodeURIComponent(project.id)}`,
		"GET",
	);
	if (!answer.ok) return fail(answer.error);
	const usage = toTeamUsage(answer.data);
	return usage ? { success: true, usage } : fail("bad_usage");
}
