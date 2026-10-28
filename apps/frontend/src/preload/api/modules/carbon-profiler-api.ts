/**
 * Carbon Profiler API
 *
 * Renderer-side bridge to the carbon profiler runner.
 */

import type { CarbonReport } from "../../../shared/types/carbon-profiler";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface CarbonProfilerRunOptions {
	projectPath: string;
	region?: string;
}

export interface CarbonProfilerEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; records?: number };
}

export interface CarbonProfilerAPI {
	runCarbonProfilerScan: (
		options: CarbonProfilerRunOptions,
	) => Promise<CarbonReport>;
	cancelCarbonProfilerScan: () => Promise<boolean>;
	onCarbonProfilerEvent: (
		callback: (event: CarbonProfilerEvent) => void,
	) => () => void;
	onCarbonProfilerResult: (
		callback: (report: CarbonReport) => void,
	) => () => void;
	onCarbonProfilerError: (callback: (error: string) => void) => () => void;
}

export const createCarbonProfilerAPI = (): CarbonProfilerAPI => ({
	runCarbonProfilerScan: (options: CarbonProfilerRunOptions) =>
		invokeIpc<CarbonReport>(IPC_CHANNELS.CARBON_PROFILER_RUN, options),

	cancelCarbonProfilerScan: () => invokeIpc<boolean>(IPC_CHANNELS.CARBON_PROFILER_CANCEL),

	onCarbonProfilerEvent: (callback) =>
		createIpcListener<[CarbonProfilerEvent]>(IPC_CHANNELS.CARBON_PROFILER_EVENT, (payload) =>
			callback(payload),
		),

	onCarbonProfilerResult: (callback) =>
		createIpcListener<[CarbonReport]>(IPC_CHANNELS.CARBON_PROFILER_RESULT, (payload) =>
			callback(payload),
		),

	onCarbonProfilerError: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.CARBON_PROFILER_ERROR, (payload) =>
			callback(payload),
		),
});
