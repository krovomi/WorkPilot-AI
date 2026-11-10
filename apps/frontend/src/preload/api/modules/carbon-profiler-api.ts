/**
 * Carbon profiler API (#365): the renderer's bridge to the carbon report,
 * the budget settings and the ESG export.
 */

import type { CarbonConfig, CarbonConfigInput, CarbonExportFormat, CarbonReport } from "../../../shared/types/carbon-profiler";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface CarbonProfilerRunOptions {
	projectPath: string;
	/** YYYY-MM; empty for the whole ledger. */
	month?: string;
	/** Rebuild the ledger from the cost records first. */
	backfill?: boolean;
}

export interface CarbonProfilerEvent {
	type: "start" | "complete" | "backfill";
	data: { status?: string; records?: number };
}

export interface CarbonProfilerAPI {
	runCarbonProfilerScan: (options: CarbonProfilerRunOptions) => Promise<CarbonReport>;
	cancelCarbonProfilerScan: () => Promise<boolean>;
	saveCarbonConfig: (projectPath: string, config: CarbonConfigInput) => Promise<CarbonConfig>;
	/** The path written, or null when the person closed the save dialog. */
	exportCarbonReport: (projectPath: string, month: string, format: CarbonExportFormat) => Promise<string | null>;
	onCarbonProfilerEvent: (callback: (event: CarbonProfilerEvent) => void) => () => void;
}

export const createCarbonProfilerAPI = (): CarbonProfilerAPI => ({
	runCarbonProfilerScan: (options) => invokeIpc<CarbonReport>(IPC_CHANNELS.CARBON_PROFILER_RUN, options),

	cancelCarbonProfilerScan: () => invokeIpc<boolean>(IPC_CHANNELS.CARBON_PROFILER_CANCEL),

	saveCarbonConfig: (projectPath, config) =>
		invokeIpc<CarbonConfig>(IPC_CHANNELS.CARBON_PROFILER_CONFIG, { projectPath, config }),

	exportCarbonReport: (projectPath, month, format) =>
		invokeIpc<string | null>(IPC_CHANNELS.CARBON_PROFILER_EXPORT, { projectPath, month, format }),

	onCarbonProfilerEvent: (callback) =>
		createIpcListener<[CarbonProfilerEvent]>(IPC_CHANNELS.CARBON_PROFILER_EVENT, (payload) => callback(payload)),
});
