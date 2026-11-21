/**
 * The agent governance of a server project (server mode, #353 lot 4): what
 * its `workpilot.policy.yaml` says, the audit trail its agents write on the
 * server, the calls they wait on, and its kill switch.
 *
 * On this computer the governance panel reads the guardrails runner
 * (`ipc-handlers/governance-handlers.ts`). A server project's agents run on
 * the server, so the server reads its clone for the project
 * (`apps/backend/shared_features/governance.py`); the app sends a project id,
 * never a path. What the server answers is rebuilt here field by field, as a
 * runner answer is: the renderer only ever sees what these functions build.
 *
 * The kill switch of the app ("Stop all agents") also asks each server project
 * the person works on to stop the runs and jobs they started there
 * ({@link stopServerAgents}): pressing it never stops a colleague's run.
 */

import type { IPCResult, Project } from "../shared/types";
import type {
	GovernanceRequest,
	GovernanceSections,
	PolicyAuditEvent,
	ServerGovernanceReport,
	ServerStopResult,
	ServerStopScope,
} from "../shared/types/governance";
import { auditEvents, auditMetrics } from "./governance/audit-export";
import { authedFetch, isServerMode } from "./server-connection";
import { listedServerProjects } from "./server-projects";

const MAX_TEXT = 1_000;
const MAX_LIST = 200;
const MAX_REQUESTS = 50;
const MAX_COUNT = 1_000_000;
/** A request id as the guardrail log writes it (`uuid4().hex[:12]`). */
export const REQUEST_ID = /^[0-9a-f]{12}$/;
export const STOP_SCOPES: readonly ServerStopScope[] = ["mine", "project"];
const UNEXPECTED = "Unexpected answer from the server";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, limit = MAX_TEXT): string | null {
	return typeof value === "string" && value ? value.slice(0, limit) : null;
}

function texts(value: unknown, limit = MAX_LIST, chars = 256): string[] {
	return Array.isArray(value)
		? value
				.filter((v): v is string => typeof v === "string" && v.length > 0)
				.slice(0, limit)
				.map((v) => v.slice(0, chars))
		: [];
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.min(Math.trunc(value), MAX_COUNT)
		: 0;
}

function limit(value: unknown): number | null {
	const n = count(value);
	return n > 0 ? n : null;
}

const path = (projectId: string, rest = "") =>
	`/api/features/governance${rest}?project_id=${encodeURIComponent(projectId)}`;

/** The governance sections the server read, rebuilt; `null` when there are none. */
export function sectionsFrom(raw: unknown): GovernanceSections | null {
	if (!isRecord(raw)) return null;
	const files = isRecord(raw.files) ? raw.files : {};
	const schedule = isRecord(raw.schedule) ? raw.schedule : null;
	const budget = isRecord(raw.budget) ? raw.budget : null;
	const loop = isRecord(raw.loopDetection) ? raw.loopDetection : null;
	return {
		source: text(raw.source) ?? "",
		schedule: schedule
			? {
					timezone: text(schedule.timezone, 64) ?? "UTC",
					allowedHours: texts(schedule.allowedHours, 8),
					days: texts(schedule.days, 7),
					openNow: schedule.openNow === true,
					localTime: text(schedule.localTime, 64),
				}
			: null,
		files: {
			forbidden: texts(files.forbidden),
			requiresReview: texts(files.requiresReview),
			reviewers: texts(files.reviewers, 20),
		},
		budget: budget
			? { maxTokensPerHour: limit(budget.maxTokensPerHour), maxTokensPerTask: limit(budget.maxTokensPerTask) }
			: null,
		loopDetection: loop && limit(loop.maxSameToolCall) ? { maxSameToolCall: count(loop.maxSameToolCall) } : null,
	};
}

/** A call waiting for an approval, rebuilt; `null` when it is not one. */
export function requestFrom(raw: unknown): GovernanceRequest | null {
	if (!isRecord(raw) || typeof raw.id !== "string" || !REQUEST_ID.test(raw.id)) return null;
	const target = isRecord(raw.target) ? raw.target : {};
	return {
		id: raw.id,
		at: text(raw.at, 64) ?? "",
		rules: texts(raw.rules, 20),
		tool: text(raw.tool, 80),
		targetKind: target.kind === "file" || target.kind === "command" ? target.kind : null,
		target: text(target.summary, 300),
		task: text(raw.task, 80),
		message: text(raw.message),
	};
}

/** The server's report, rebuilt for the panel. */
export function reportFrom(raw: unknown): ServerGovernanceReport | null {
	if (!isRecord(raw)) return null;
	const agents = isRecord(raw.agents) ? raw.agents : {};
	const may = isRecord(raw.may) ? raw.may : {};
	return {
		governance: sectionsFrom(raw.governance),
		errors: texts(raw.errors, 50, 500),
		sources: Array.isArray(raw.sources)
			? raw.sources
					.filter(isRecord)
					.slice(0, 10)
					.map((s) => ({ layer: text(s.layer, 20) ?? "", path: text(s.path, 300) ?? "", rules: count(s.rules) }))
			: [],
		tokensLastHour: count(raw.tokensLastHour),
		events: auditEvents(raw).slice(0, 50),
		metrics: auditMetrics(raw),
		pending: (Array.isArray(raw.pending) ? raw.pending : [])
			.slice(0, MAX_REQUESTS)
			.map(requestFrom)
			.filter((r): r is GovernanceRequest => r !== null),
		agents: { mine: count(agents.mine), project: count(agents.project) },
		may: {
			approve: may.approve === true,
			stop: may.stop === true,
			stopProject: may.stopProject === true,
			export: may.export === true,
		},
	};
}

export async function fetchServerGovernance(project: Project): Promise<IPCResult<ServerGovernanceReport>> {
	const result = await authedFetch<unknown>(path(project.id), "GET");
	if (!result.ok) return { success: false, error: result.error };
	const report = reportFrom(result.data);
	return report ? { success: true, data: report } : { success: false, error: UNEXPECTED };
}

/** The whole trail of a server project, rebuilt, for an export. */
export async function fetchServerAudit(project: Project): Promise<IPCResult<PolicyAuditEvent[]>> {
	const result = await authedFetch<unknown>(path(project.id, "/audit"), "GET");
	if (!result.ok) return { success: false, error: result.error };
	return { success: true, data: auditEvents(result.data) };
}

/** Approve or refuse one call, as the person signed in to the server. */
export async function answerServerRequest(
	project: Project,
	requestId: unknown,
	approved: unknown,
): Promise<IPCResult<{ decision: "approved" | "refused" }>> {
	if (typeof requestId !== "string" || !REQUEST_ID.test(requestId) || typeof approved !== "boolean") {
		return { success: false, error: "Not a request of the server" };
	}
	const result = await authedFetch<{ answer?: { decision?: unknown } }>(
		path(project.id, `/approvals/${requestId}`),
		"POST",
		{ approved },
	);
	if (!result.ok) return { success: false, error: result.error };
	const decision = result.data?.answer?.decision;
	return decision === "approved" || decision === "refused"
		? { success: true, data: { decision } }
		: { success: false, error: UNEXPECTED };
}

/** The kill switch of one server project: the person's agents, or all of them. */
export async function stopServerProject(project: Project, scope: unknown): Promise<IPCResult<ServerStopResult>> {
	if (!(STOP_SCOPES as readonly unknown[]).includes(scope)) {
		return { success: false, error: "scope must be mine or project" };
	}
	const result = await authedFetch<Record<string, unknown>>(path(project.id, "/stop"), "POST", { scope });
	if (!result.ok) return { success: false, error: result.error };
	return {
		success: true,
		data: { stoppedRuns: count(result.data?.stoppedRuns), stoppedJobs: count(result.data?.stoppedJobs) },
	};
}

/**
 * "Stop all agents", on the server: in every server project the person may
 * stop agents in (role member or owner), the runs and jobs they started.
 * One project that does not answer does not keep the others running.
 */
export async function stopServerAgents(): Promise<{ stopped: number; failed: number }> {
	if (!isServerMode()) return { stopped: 0, failed: 0 };
	const projects = listedServerProjects().filter((p) => p.remote && p.remote.role !== "viewer");
	const answers = await Promise.all(projects.map((project) => stopServerProject(project, "mine")));
	let stopped = 0;
	let failed = 0;
	for (const answer of answers) {
		if (answer.success && answer.data) stopped += answer.data.stoppedRuns + answer.data.stoppedJobs;
		else failed += 1;
	}
	return { stopped, failed };
}
