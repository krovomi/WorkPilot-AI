/**
 * Notebook Agent API
 *
 * Renderer-side bridge to the notebook agent runner.
 */

import type {
	NotebookExecution,
	NotebookMonth,
	NotebookRefactorOutcome,
	NotebookRefactorRequest,
	NotebookRunRequest,
	ParsedNotebook,
} from "../../../shared/types/notebook-agent";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface NotebookAgentRunOptions {
	projectPath: string;
}

export interface NotebookAgentResult {
	notebooks: ParsedNotebook[];
}

export interface NotebookAgentEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; notebooks?: number; issues?: number };
}

export interface NotebookAgentAPI {
	runNotebookAgentScan: (
		options: NotebookAgentRunOptions,
	) => Promise<NotebookAgentResult>;
	cancelNotebookAgentScan: () => Promise<boolean>;
	executeNotebook: (request: NotebookRunRequest) => Promise<NotebookExecution>;
	refactorNotebook: (request: NotebookRefactorRequest) => Promise<NotebookRefactorOutcome>;
	getNotebookMetrics: (options: NotebookAgentRunOptions) => Promise<NotebookMonth[]>;
	onNotebookAgentEvent: (
		callback: (event: NotebookAgentEvent) => void,
	) => () => void;
	onNotebookAgentResult: (
		callback: (result: NotebookAgentResult) => void,
	) => () => void;
	onNotebookAgentError: (callback: (error: string) => void) => () => void;
}

export const createNotebookAgentAPI = (): NotebookAgentAPI => ({
	runNotebookAgentScan: (options: NotebookAgentRunOptions) =>
		invokeIpc<NotebookAgentResult>(IPC_CHANNELS.NOTEBOOK_AGENT_RUN, options),

	cancelNotebookAgentScan: () => invokeIpc<boolean>(IPC_CHANNELS.NOTEBOOK_AGENT_CANCEL),

	executeNotebook: (request: NotebookRunRequest) =>
		invokeIpc<NotebookExecution>(IPC_CHANNELS.NOTEBOOK_AGENT_EXECUTE, request),

	refactorNotebook: (request: NotebookRefactorRequest) =>
		invokeIpc<NotebookRefactorOutcome>(IPC_CHANNELS.NOTEBOOK_AGENT_REFACTOR, request),

	getNotebookMetrics: (options: NotebookAgentRunOptions) =>
		invokeIpc<NotebookMonth[]>(IPC_CHANNELS.NOTEBOOK_AGENT_METRICS, options),

	onNotebookAgentEvent: (callback) =>
		createIpcListener<[NotebookAgentEvent]>(IPC_CHANNELS.NOTEBOOK_EVENT, (payload) =>
			callback(payload),
		),

	onNotebookAgentResult: (callback) =>
		createIpcListener<[NotebookAgentResult]>(IPC_CHANNELS.NOTEBOOK_RESULT, (payload) =>
			callback(payload),
		),

	onNotebookAgentError: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.NOTEBOOK_ERROR, (payload) =>
			callback(payload),
		),
});
