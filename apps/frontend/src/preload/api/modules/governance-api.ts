/**
 * Governance API — the read-only panel of workpilot.policy.yaml (hours, files,
 * token budget), its errors, the policy's last decisions, and the audit export.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	AuditExportFormat,
	AuditExportResult,
	GovernanceReport,
} from "../../../shared/types/governance";
import { invokeIpc } from "./ipc-utils";

export interface GovernanceAPI {
	getGovernanceReport: (projectPath: string) => Promise<GovernanceReport>;
	/** Asks where to save in a native dialog; `null` when the person cancels. */
	exportPolicyAudit: (projectPath: string, format: AuditExportFormat) => Promise<AuditExportResult>;
}

export const createGovernanceAPI = (): GovernanceAPI => ({
	getGovernanceReport: (projectPath) =>
		invokeIpc<GovernanceReport>(IPC_CHANNELS.GOVERNANCE_REPORT, { projectPath }),
	exportPolicyAudit: (projectPath, format) =>
		invokeIpc<AuditExportResult>(IPC_CHANNELS.GOVERNANCE_EXPORT_AUDIT, { projectPath, format }),
});
