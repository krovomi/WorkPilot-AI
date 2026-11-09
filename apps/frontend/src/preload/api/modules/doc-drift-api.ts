/**
 * Doc Drift API
 *
 * Renderer-side bridge to the documentation drift scanner runner.
 */

import type {
	DocDriftExportFormat,
	DocDriftFixOutcome,
	DocDriftFixRequest,
	DriftReport,
} from "../../../shared/types/doc-drift";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface DocDriftRunOptions {
	projectPath: string;
}

export interface DocDriftEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; issues?: number; docsScanned?: number };
}

/** The HTML export, worded by the renderer in the app's language. */
export interface DocDriftExportDocument {
	title: string;
	summary: string;
	tables: { title: string; columns: string[]; rows: string[][] }[];
}

export interface DocDriftAPI {
	runDocDriftScan: (options: DocDriftRunOptions) => Promise<DriftReport>;
	cancelDocDriftScan: () => Promise<boolean>;
	/** The fixes named, made on a review card (#354). */
	fixDocDrift: (request: DocDriftFixRequest) => Promise<DocDriftFixOutcome>;
	/** Saves the report where the person picks; null when cancelled. */
	exportDocDrift: (request: {
		format: DocDriftExportFormat;
		report: DriftReport;
		document: DocDriftExportDocument;
	}) => Promise<string | null>;
	onDocDriftEvent: (callback: (event: DocDriftEvent) => void) => () => void;
	onDocDriftResult: (callback: (report: DriftReport) => void) => () => void;
	onDocDriftError: (callback: (error: string) => void) => () => void;
}

export const createDocDriftAPI = (): DocDriftAPI => ({
	runDocDriftScan: (options: DocDriftRunOptions) =>
		invokeIpc<DriftReport>(IPC_CHANNELS.DOC_DRIFT_RUN, options),

	cancelDocDriftScan: () => invokeIpc<boolean>(IPC_CHANNELS.DOC_DRIFT_CANCEL),

	fixDocDrift: (request) => invokeIpc<DocDriftFixOutcome>(IPC_CHANNELS.DOC_DRIFT_FIX, request),

	exportDocDrift: (request) => invokeIpc<string | null>(IPC_CHANNELS.DOC_DRIFT_EXPORT, request),

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
