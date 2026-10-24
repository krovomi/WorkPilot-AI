/**
 * Doc Drift API
 *
 * Renderer-side bridge to the documentation drift scanner runner.
 */

import type { DriftReport } from "../../../shared/types/doc-drift";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface DocDriftRunOptions {
	projectPath: string;
}

export interface DocDriftEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; issues?: number; docsScanned?: number };
}

export interface DocDriftAPI {
	runDocDriftScan: (options: DocDriftRunOptions) => Promise<DriftReport>;
	cancelDocDriftScan: () => Promise<boolean>;
	onDocDriftEvent: (callback: (event: DocDriftEvent) => void) => () => void;
	onDocDriftResult: (callback: (report: DriftReport) => void) => () => void;
	onDocDriftError: (callback: (error: string) => void) => () => void;
}

export const createDocDriftAPI = (): DocDriftAPI => ({
	runDocDriftScan: (options: DocDriftRunOptions) =>
		invokeIpc<DriftReport>(IPC_CHANNELS.DOC_DRIFT_RUN, options),

	cancelDocDriftScan: () => invokeIpc<boolean>(IPC_CHANNELS.DOC_DRIFT_CANCEL),

	onDocDriftEvent: (callback) =>
		createIpcListener<[DocDriftEvent]>(IPC_CHANNELS.DOC_DRIFT_EVENT, (payload) =>
			callback(payload),
		),

	onDocDriftResult: (callback) =>
		createIpcListener<[DriftReport]>(IPC_CHANNELS.DOC_DRIFT_RESULT, (payload) =>
			callback(payload),
		),

	onDocDriftError: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.DOC_DRIFT_ERROR, (payload) =>
			callback(payload),
		),
});
