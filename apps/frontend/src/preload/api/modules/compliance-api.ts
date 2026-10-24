/**
 * Compliance API
 *
 * Renderer-side bridge to the compliance evidence collector runner.
 */

import type {
	ComplianceFramework,
	ComplianceReport,
} from "../../../shared/types/compliance";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface ComplianceRunOptions {
	projectPath: string;
	framework?: ComplianceFramework;
}

export interface ComplianceEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; collected?: number; missing?: number };
}

export interface ComplianceAPI {
	runComplianceScan: (options: ComplianceRunOptions) => Promise<ComplianceReport>;
	cancelComplianceScan: () => Promise<boolean>;
	onComplianceEvent: (
		callback: (event: ComplianceEvent) => void,
	) => () => void;
	onComplianceResult: (
		callback: (report: ComplianceReport) => void,
	) => () => void;
	onComplianceError: (callback: (error: string) => void) => () => void;
}

export const createComplianceAPI = (): ComplianceAPI => ({
	runComplianceScan: (options: ComplianceRunOptions) =>
		invokeIpc<ComplianceReport>(IPC_CHANNELS.COMPLIANCE_RUN, options),

	cancelComplianceScan: () => invokeIpc<boolean>(IPC_CHANNELS.COMPLIANCE_CANCEL),

	onComplianceEvent: (callback) =>
		createIpcListener<[ComplianceEvent]>(IPC_CHANNELS.COMPLIANCE_EVENT, (payload) =>
			callback(payload),
		),

	onComplianceResult: (callback) =>
		createIpcListener<[ComplianceReport]>(IPC_CHANNELS.COMPLIANCE_RESULT, (payload) =>
			callback(payload),
		),

	onComplianceError: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.COMPLIANCE_ERROR, (payload) =>
			callback(payload),
		),
});
