/**
 * Compliance API (#357): the renderer's bridge to the compliance collector.
 * Main checks every argument again (S6).
 */

import type {
	ComplianceConfig,
	ComplianceExportDocument,
	ComplianceExportFormat,
	ComplianceFrameworks,
	ComplianceReport,
	ComplianceReportListing,
} from "../../../shared/types/compliance";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { createIpcListener, invokeIpc } from "./ipc-utils";

export interface ComplianceRunOptions {
	projectPath: string;
	framework: string;
	/** YYYY-MM; this month to date when absent. */
	period?: string;
	save?: boolean;
}

export interface ComplianceEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; controls?: number; gaps?: number };
}

export interface ComplianceAPI {
	runComplianceScan: (options: ComplianceRunOptions) => Promise<ComplianceReport>;
	cancelComplianceScan: () => Promise<boolean>;
	getComplianceFrameworks: (projectPath: string) => Promise<ComplianceFrameworks>;
	listComplianceReports: (projectPath: string) => Promise<{ reports: ComplianceReportListing[] }>;
	loadComplianceReport: (projectPath: string, name: string) => Promise<ComplianceReport>;
	saveComplianceConfig: (projectPath: string, config: ComplianceConfig) => Promise<{ config: ComplianceConfig }>;
	/** The path written, or null when the person cancelled the dialog. */
	exportComplianceReport: (request: {
		format: ComplianceExportFormat;
		document: ComplianceExportDocument;
		language: string;
	}) => Promise<string | null>;
	onComplianceEvent: (callback: (event: ComplianceEvent) => void) => () => void;
}

export const createComplianceAPI = (): ComplianceAPI => ({
	runComplianceScan: (options) => invokeIpc<ComplianceReport>(IPC_CHANNELS.COMPLIANCE_RUN, options),
	cancelComplianceScan: () => invokeIpc<boolean>(IPC_CHANNELS.COMPLIANCE_CANCEL),
	getComplianceFrameworks: (projectPath) =>
		invokeIpc<ComplianceFrameworks>(IPC_CHANNELS.COMPLIANCE_FRAMEWORKS, { projectPath }),
	listComplianceReports: (projectPath) =>
		invokeIpc<{ reports: ComplianceReportListing[] }>(IPC_CHANNELS.COMPLIANCE_REPORTS, { projectPath }),
	loadComplianceReport: (projectPath, name) =>
		invokeIpc<ComplianceReport>(IPC_CHANNELS.COMPLIANCE_LOAD, { projectPath, name }),
	saveComplianceConfig: (projectPath, config) =>
		invokeIpc<{ config: ComplianceConfig }>(IPC_CHANNELS.COMPLIANCE_CONFIG, { projectPath, config }),
	exportComplianceReport: (request) => invokeIpc<string | null>(IPC_CHANNELS.COMPLIANCE_EXPORT, request),
	onComplianceEvent: (callback) =>
		createIpcListener<[ComplianceEvent]>(IPC_CHANNELS.COMPLIANCE_EVENT, (payload) => callback(payload)),
});
