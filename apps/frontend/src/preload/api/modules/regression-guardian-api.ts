/**
 * Regression Guardian API
 *
 * Renderer-side bridge to the regression guardian runner which turns
 * persisted APM incident payloads into regression test candidates.
 */

import type { RegressionGuardianResult } from "../../../shared/types/regression-guardian";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface RegressionGuardianRunOptions {
	projectPath: string;
}

export interface RegressionGuardianScanResult {
	results: RegressionGuardianResult[];
}

export interface RegressionGuardianEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; results?: number };
}

export interface RegressionGuardianAPI {
	runRegressionGuardianScan: (
		options: RegressionGuardianRunOptions,
	) => Promise<RegressionGuardianScanResult>;
	cancelRegressionGuardianScan: () => Promise<boolean>;
	onRegressionGuardianEvent: (
		callback: (event: RegressionGuardianEvent) => void,
	) => () => void;
	onRegressionGuardianResult: (
		callback: (result: RegressionGuardianScanResult) => void,
	) => () => void;
	onRegressionGuardianError: (
		callback: (error: string) => void,
	) => () => void;
}

export const createRegressionGuardianAPI = (): RegressionGuardianAPI => ({
	runRegressionGuardianScan: (options: RegressionGuardianRunOptions) =>
		invokeIpc<RegressionGuardianScanResult>(
			IPC_CHANNELS.REGRESSION_GUARDIAN_RUN,
			options,
		),

	cancelRegressionGuardianScan: () =>
		invokeIpc<boolean>(IPC_CHANNELS.REGRESSION_GUARDIAN_CANCEL),

	onRegressionGuardianEvent: (callback) =>
		createIpcListener<[RegressionGuardianEvent]>(
			IPC_CHANNELS.REGRESSION_GUARDIAN_EVENT,
			(payload) => callback(payload),
		),

	onRegressionGuardianResult: (callback) =>
		createIpcListener<[RegressionGuardianScanResult]>(
			IPC_CHANNELS.REGRESSION_GUARDIAN_RESULT,
			(payload) => callback(payload),
		),

	onRegressionGuardianError: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.REGRESSION_GUARDIAN_ERROR, (payload) =>
			callback(payload),
		),
});
