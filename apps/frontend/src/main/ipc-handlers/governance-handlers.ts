/**
 * The governance panel of Settings > Guardrails (#353, lot 2): what
 * `workpilot.policy.yaml` says about hours, files and the token budget, its
 * errors, the policy's last decisions, and the export of its audit trail.
 *
 * Channels:
 *   governance:report       → { projectPath } → GovernanceReport
 *   governance:exportAudit  → { projectPath, format: "csv" | "json" } → AuditExportResult
 *
 * Both read the guardrails runner, the one implementation the agents are held
 * to. The renderer names a registered project and a format from a closed list;
 * the main asks where to save in a native dialog and writes only there.
 */

import { writeFile } from "node:fs/promises";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { AuditExportResult, GovernanceReport } from "../../shared/types/governance";
import { showSaveDialog } from "../electron-utils";
import { auditEvents, auditFormat, serializeAudit } from "../governance/audit-export";
import { resolveKnownProject } from "../security/renderer-path";
import { runGuardrails } from "./guardrails-handlers";

type Request = { projectPath?: unknown; format?: unknown } | undefined;

function knownProject(request: Request): string {
	const root = resolveKnownProject(request?.projectPath);
	if (!root) throw new Error("Not a project of this app");
	return root;
}

export async function governanceReport(request: Request): Promise<GovernanceReport> {
	const root = knownProject(request);
	const answer = (await runGuardrails("governance", { projectPath: root })) as GovernanceReport;
	return { ...answer, events: auditEvents(answer) };
}

export async function exportAudit(request: Request, today = new Date()): Promise<AuditExportResult> {
	const root = knownProject(request);
	const format = auditFormat(request?.format);
	const events = auditEvents(await runGuardrails("audit", { projectPath: root }));
	const { canceled, filePath } = await showSaveDialog({
		defaultPath: `policy-audit-${today.toISOString().slice(0, 10)}.${format}`,
		filters: [{ name: format.toUpperCase(), extensions: [format] }],
	});
	if (canceled || !filePath) return null;
	await writeFile(filePath, serializeAudit(format, events), "utf-8");
	return { filePath, count: events.length };
}

export function registerGovernanceHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.GOVERNANCE_REPORT, (_evt, request: Request) => governanceReport(request));
	ipcMain.handle(IPC_CHANNELS.GOVERNANCE_EXPORT_AUDIT, (_evt, request: Request) => exportAudit(request));
}
