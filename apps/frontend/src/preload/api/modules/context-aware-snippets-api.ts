import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	ContextAwareSnippetResult,
	ContextAwareSnippetsError,
	ContextAwareSnippetsStartResult,
	ContextAwareSnippetsStatus,
	SnippetType,
} from "../../../shared/types/context-aware-snippets";
import { createIpcListener, type IpcListenerCleanup } from "./ipc-utils";

/**
 * Context-Aware Snippets API
 *
 * The renderer names the project by id; the main process resolves its path,
 * its Python and its backend. There is no `configure` any more: it let the
 * renderer choose which executable the main process would spawn.
 */
export interface ContextAwareSnippetsAPI {
	generateContextAwareSnippet: (
		projectId: string,
		snippetType: SnippetType,
		description: string,
		language?: string,
	) => Promise<ContextAwareSnippetsStartResult>;
	cancelSnippetGeneration: () => Promise<{
		success: boolean;
		cancelled?: boolean;
	}>;
	// Chaque abonnement rend sa fonction de desabonnement, comme partout
	// ailleurs dans ce dossier.
	onSnippetStreamChunk: (
		callback: (chunk: string) => void,
	) => IpcListenerCleanup;
	onSnippetStatus: (
		callback: (status: ContextAwareSnippetsStatus) => void,
	) => IpcListenerCleanup;
	onSnippetError: (
		callback: (error: ContextAwareSnippetsError) => void,
	) => IpcListenerCleanup;
	onSnippetComplete: (
		callback: (result: ContextAwareSnippetResult) => void,
	) => IpcListenerCleanup;
}

export const createContextAwareSnippetsAPI = (): ContextAwareSnippetsAPI => ({
	generateContextAwareSnippet: (
		projectId: string,
		snippetType: SnippetType,
		description: string,
		language?: string,
	): Promise<ContextAwareSnippetsStartResult> =>
		ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_AWARE_SNIPPETS_GENERATE, {
			projectId,
			snippetType,
			description,
			language,
		}),

	cancelSnippetGeneration: (): Promise<{
		success: boolean;
		cancelled?: boolean;
	}> => ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_AWARE_SNIPPETS_CANCEL),

	onSnippetStreamChunk: (callback: (chunk: string) => void) =>
		createIpcListener<[string]>(
			IPC_CHANNELS.CONTEXT_AWARE_SNIPPETS_STREAM_CHUNK,
			callback,
		),

	onSnippetStatus: (callback: (status: ContextAwareSnippetsStatus) => void) =>
		createIpcListener<[ContextAwareSnippetsStatus]>(
			IPC_CHANNELS.CONTEXT_AWARE_SNIPPETS_STATUS,
			callback,
		),

	onSnippetError: (callback: (error: ContextAwareSnippetsError) => void) =>
		createIpcListener<[ContextAwareSnippetsError]>(
			IPC_CHANNELS.CONTEXT_AWARE_SNIPPETS_ERROR,
			callback,
		),

	onSnippetComplete: (callback: (result: ContextAwareSnippetResult) => void) =>
		createIpcListener<[ContextAwareSnippetResult]>(
			IPC_CHANNELS.CONTEXT_AWARE_SNIPPETS_COMPLETE,
			callback,
		),
});
