/**
 * The governance panel of Settings > Guardrails (#353, lots 2-4): what
 * `workpilot.policy.yaml` says about hours, files, token budgets and the
 * circuit breaker, its errors, the policy's last decisions and their counts,
 * and the export of its audit trail.
 *
 * Channels, for a project of this computer:
 *   governance:report       → { projectPath } → GovernanceReport
 *   governance:exportAudit  → { projectPath, format: "csv" | "json" } → AuditExportResult
 * Both read the guardrails runner, the one implementation the agents are held to.
 *
 * And for a project of the server (`../server-governance.ts`), by id:
 *   governance:serverReport → { projectId } → IPCResult<ServerGovernanceReport>
 *   governance:serverExport → { projectId, format } → IPCResult<AuditExportResult>
 *   governance:serverAnswer → { projectId, requestId, approved } → IPCResult<{ decision }>
 *   governance:serverStop   → { projectId, scope: "mine" | "project" } → IPCResult<ServerStopResult>
 *
 * The renderer names a registered project (or a listed server project) and
 * values from closed lists; the main asks where to save in a native dialog and
 * writes only there.
 */

import { writeFile } from "node:fs/promises";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { IPCResult, Project } from "../../shared/types";
import type {
	AuditExportFormat,
	AuditExportResult,
	GovernanceReport,
	PolicyAuditEvent,
} from "../../shared/types/governance";
import { showSaveDialog } from "../electron-utils";
import { auditEvents, auditFormat, auditMetrics, serializeAudit } from "../governance/audit-export";
import { resolveKnownProject } from "../security/renderer-path";
import {
	answerServerRequest,
	fetchServerAudit,
	fetchServerGovernance,
	stopServerProject,
} from "../server-governance";
import { getServerProject } from "../server-projects";
import { runGuardrails } from "./guardrails-handlers";

type Request = { projectPath?: unknown; format?: unknown } | undefined;
type ServerRequest =
	| { projectId?: unknown; format?: unknown; requestId?: unknown; approved?: unknown; scope?: unknown }
	| undefined;

const NOT_A_SERVER_PROJECT = "Not a project of the server";

function knownProject(request: Request): string {
	const root = resolveKnownProject(request?.projectPath);
	if (!root) throw new Error("Not a project of this app");
	return root;
}

export async function governanceReport(request: Request): Promise<GovernanceReport> {
	const root = knownProject(request);
	const answer = (await runGuardrails("governance", { projectPath: root })) as GovernanceReport;
	return { ...answer, events: auditEvents(answer), metrics: auditMetrics(answer) };
}

/** Write the trail where the person chooses; `null` when they close the dialog. */
async function saveAudit(
	format: AuditExportFormat,
	events: PolicyAuditEvent[],
	today: Date,
): Promise<AuditExportResult> {
	const { canceled, filePath } = await showSaveDialog({
		defaultPath: `policy-audit-${today.toISOString().slice(0, 10)}.${format}`,
		filters: [{ name: format.toUpperCase(), extensions: [format] }],
	});
	if (canceled || !filePath) return null;
	await writeFile(filePath, serializeAudit(format, events), "utf-8");
	return { filePath, count: events.length };
}

export async function exportAudit(request: Request, today = new Date()): Promise<AuditExportResult> {
	const root = knownProject(request);
	const format = auditFormat(request?.format);
	return saveAudit(format, auditEvents(await runGuardrails("audit", { projectPath: root })), today);
}

/** The export of a server project's trail: read from the server, saved here. */
export async function exportServerAudit(
	project: Project,
	request: ServerRequest,
	today = new Date(),
): Promise<IPCResult<AuditExportResult>> {
	let format: AuditExportFormat;
	try {
		format = auditFormat(request?.format);
	} catch (error) {
		return { success: false, error: (error as Error).message };
	}
	const events = await fetchServerAudit(project);
	if (!events.success || !events.data) return { success: false, error: events.error };
	return { success: true, data: await saveAudit(format, events.data, today) };
}

function onServerProject<T>(
	act: (project: Project, request: ServerRequest) => Promise<IPCResult<T>>,
): (_event: unknown, request: ServerRequest) => Promise<IPCResult<T>> {
	return async (_event, request) => {
		const project = getServerProject(request?.projectId);
		if (!project) return { success: false, error: NOT_A_SERVER_PROJECT };
		return act(project, request);
	};
}

export function registerGovernanceHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.GOVERNANCE_REPORT, (_evt, request: Request) => governanceReport(request));
	ipcMain.handle(IPC_CHANNELS.GOVERNANCE_EXPORT_AUDIT, (_evt, request: Request) => exportAudit(request));
	ipcMain.handle(
		IPC_CHANNELS.GOVERNANCE_SERVER_REPORT,
		onServerProject((project) => fetchServerGovernance(project)),
	);
	ipcMain.handle(
		IPC_CHANNELS.GOVERNANCE_SERVER_EXPORT,
		onServerProject((project, request) => exportServerAudit(project, request)),
	);
	ipcMain.handle(
		IPC_CHANNELS.GOVERNANCE_SERVER_ANSWER,
		onServerProject((project, request) => answerServerRequest(project, request?.requestId, request?.approved)),
	);
	ipcMain.handle(
		IPC_CHANNELS.GOVERNANCE_SERVER_STOP,
		onServerProject((project, request) => stopServerProject(project, request?.scope)),
	);
}
