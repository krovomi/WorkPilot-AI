/**
 * API Watcher API
 *
 * Renderer-side bridge to the api watcher runner.
 */

import type { ContractDiff } from "../../../shared/types/api-watcher";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface ApiWatcherRunOptions {
	projectPath: string;
	saveBaseline?: boolean;
}

export interface ApiWatcherResult {
	diff: ContractDiff;
	migrationGuideMarkdown: string;
	summary: string;
}

export interface ApiWatcherEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; breaking?: number };
}

export interface ApiWatcherAPI {
	runApiWatcherScan: (
		options: ApiWatcherRunOptions,
	) => Promise<ApiWatcherResult>;
	cancelApiWatcherScan: () => Promise<boolean>;
	onApiWatcherEvent: (
		callback: (event: ApiWatcherEvent) => void,
	) => () => void;
	onApiWatcherResult: (
		callback: (result: ApiWatcherResult) => void,
	) => () => void;
	onApiWatcherError: (callback: (error: string) => void) => () => void;
}

export const createApiWatcherAPI = (): ApiWatcherAPI => ({
	runApiWatcherScan: (options: ApiWatcherRunOptions) =>
		invokeIpc<ApiWatcherResult>(IPC_CHANNELS.API_WATCHER_RUN, options),

	cancelApiWatcherScan: () => invokeIpc<boolean>(IPC_CHANNELS.API_WATCHER_CANCEL),

	onApiWatcherEvent: (callback) =>
		createIpcListener<[ApiWatcherEvent]>(IPC_CHANNELS.API_WATCHER_EVENT, (payload) =>
			callback(payload),
		),

	onApiWatcherResult: (callback) =>
		createIpcListener<[ApiWatcherResult]>(IPC_CHANNELS.API_WATCHER_RESULT, (payload) =>
			callback(payload),
		),

	onApiWatcherError: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.API_WATCHER_ERROR, (payload) =>
			callback(payload),
		),
});
