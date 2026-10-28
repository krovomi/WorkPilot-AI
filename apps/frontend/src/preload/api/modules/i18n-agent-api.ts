/**
 * i18n Agent API
 *
 * Renderer-side bridge to the i18n scanner runner.
 */

import type { I18nReport } from "../../../shared/types/i18n-agent";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface I18nAgentRunOptions {
	projectPath: string;
	referenceLocale?: string;
}

export interface I18nAgentEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; issues?: number; filesScanned?: number };
}

export interface I18nAgentAPI {
	runI18nScan: (options: I18nAgentRunOptions) => Promise<I18nReport>;
	cancelI18nScan: () => Promise<boolean>;
	onI18nAgentEvent: (
		callback: (event: I18nAgentEvent) => void,
	) => () => void;
	onI18nAgentResult: (
		callback: (report: I18nReport) => void,
	) => () => void;
	onI18nAgentError: (callback: (error: string) => void) => () => void;
}

export const createI18nAgentAPI = (): I18nAgentAPI => ({
	runI18nScan: (options: I18nAgentRunOptions) =>
		invokeIpc<I18nReport>(IPC_CHANNELS.I18N_AGENT_RUN, options),

	cancelI18nScan: () => invokeIpc<boolean>(IPC_CHANNELS.I18N_AGENT_CANCEL),

	onI18nAgentEvent: (callback) =>
		createIpcListener<[I18nAgentEvent]>(IPC_CHANNELS.I18N_AGENT_EVENT, (payload) =>
			callback(payload),
		),

	onI18nAgentResult: (callback) =>
		createIpcListener<[I18nReport]>(IPC_CHANNELS.I18N_AGENT_RESULT, (payload) =>
			callback(payload),
		),

	onI18nAgentError: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.I18N_AGENT_ERROR, (payload) =>
			callback(payload),
		),
});
