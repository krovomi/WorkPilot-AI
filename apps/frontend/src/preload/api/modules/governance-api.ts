/**
 * Governance API — the read-only panel of workpilot.policy.yaml (hours, files,
 * token budget), its errors, the policy's last decisions, and the audit export;
 * for a server project, the same read from the server, the calls its agents
 * wait on, and its kill switch.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { IPCResult } from "../../../shared/types";
import type {
	AuditExportFormat,
	AuditExportResult,
	GovernanceReport,
	ServerGovernanceReport,
	ServerStopResult,
	ServerStopScope,
} from "../../../shared/types/governance";
import { invokeIpc } from "./ipc-utils";

export interface GovernanceAPI {
	getGovernanceReport: (projectPath: string) => Promise<GovernanceReport>;
	/** Asks where to save in a native dialog; `null` when the person cancels. */
	exportPolicyAudit: (projectPath: string, format: AuditExportFormat) => Promise<AuditExportResult>;
	getServerGovernance: (projectId: string) => Promise<IPCResult<ServerGovernanceReport>>;
	exportServerPolicyAudit: (projectId: string, format: AuditExportFormat) => Promise<IPCResult<AuditExportResult>>;
	/** Approve or refuse a call an agent of the server project waits on. */
	answerServerGovernanceRequest: (
		projectId: string,
		requestId: string,
		approved: boolean,
	) => Promise<IPCResult<{ decision: "approved" | "refused" }>>;
	stopServerProjectAgents: (projectId: string, scope: ServerStopScope) => Promise<IPCResult<ServerStopResult>>;
}

export const createGovernanceAPI = (): GovernanceAPI => ({
	getGovernanceReport: (projectPath) =>
		invokeIpc<GovernanceReport>(IPC_CHANNELS.GOVERNANCE_REPORT, { projectPath }),
	exportPolicyAudit: (projectPath, format) =>
		invokeIpc<AuditExportResult>(IPC_CHANNELS.GOVERNANCE_EXPORT_AUDIT, { projectPath, format }),
	getServerGovernance: (projectId) =>
		invokeIpc<IPCResult<ServerGovernanceReport>>(IPC_CHANNELS.GOVERNANCE_SERVER_REPORT, { projectId }),
	exportServerPolicyAudit: (projectId, format) =>
		invokeIpc<IPCResult<AuditExportResult>>(IPC_CHANNELS.GOVERNANCE_SERVER_EXPORT, { projectId, format }),
	answerServerGovernanceRequest: (projectId, requestId, approved) =>
		invokeIpc<IPCResult<{ decision: "approved" | "refused" }>>(IPC_CHANNELS.GOVERNANCE_SERVER_ANSWER, {
			projectId,
			requestId,
			approved,
		}),
	stopServerProjectAgents: (projectId, scope) =>
		invokeIpc<IPCResult<ServerStopResult>>(IPC_CHANNELS.GOVERNANCE_SERVER_STOP, { projectId, scope }),
});
