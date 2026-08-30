import { ipcRenderer } from "electron";
import type { ContextAwareSnippetResult } from "../../../main/context-aware-snippets-service";
import { createIpcListener, type IpcListenerCleanup } from "./ipc-utils";

/**
 * Context-Aware Snippets API
 *
 * Provides access to context-aware snippet generation functionality
 * from the renderer process.
 */

export interface ContextAwareSnippetsAPI {
	generateContextAwareSnippet: (
		projectDir: string,
		snippetType:
			| "component"
			| "function"
			| "class"
			| "hook"
			| "utility"
			| "api"
			| "test",
		description: string,
		language?: string,
		model?: string,
		thinkingLevel?: string,
	) => Promise<{ success: boolean; error?: string }>;
	cancelSnippetGeneration: () => Promise<{
		success: boolean;
		cancelled?: boolean;
		error?: string;
	}>;
	configureSnippetsService: (
		pythonPath?: string,
		autoBuildSourcePath?: string,
	) => Promise<{ success: boolean; error?: string }>;
	// Chaque abonnement rend sa fonction de desabonnement, comme partout
	// ailleurs dans ce dossier. Ils rendaient `void`, et les quatre
	// `removeSnippet*Listener` qui devaient compenser passaient a
	// `removeListener` une fleche fraichement creee, qui ne pouvait
	// correspondre a celle enregistree par `on` : aucun des deux chemins ne
	// liberait quoi que ce soit, et le store rouvrait un ecouteur a chaque
	// generation. Ces quatre methodes sont parties avec le probleme.
	onSnippetStreamChunk: (
		callback: (chunk: string) => void,
	) => IpcListenerCleanup;
	onSnippetStatus: (callback: (status: string) => void) => IpcListenerCleanup;
	onSnippetError: (callback: (error: string) => void) => IpcListenerCleanup;
	onSnippetComplete: (
		callback: (result: ContextAwareSnippetResult) => void,
	) => IpcListenerCleanup;
}

export const createContextAwareSnippetsAPI = (): ContextAwareSnippetsAPI => ({
	generateContextAwareSnippet: async (
		projectDir: string,
		snippetType:
			| "component"
			| "function"
			| "class"
			| "hook"
			| "utility"
			| "api"
			| "test",
		description: string,
		language?: string,
		model?: string,
		thinkingLevel?: string,
	): Promise<{ success: boolean; error?: string }> => {
		return await ipcRenderer.invoke("context-aware-snippets:generate", {
			projectDir,
			snippetType,
			description,
			language,
			model,
			thinkingLevel,
		});
	},

	cancelSnippetGeneration: async (): Promise<{
		success: boolean;
		cancelled?: boolean;
		error?: string;
	}> => {
		return await ipcRenderer.invoke("context-aware-snippets:cancel");
	},

	configureSnippetsService: async (
		pythonPath?: string,
		autoBuildSourcePath?: string,
	): Promise<{ success: boolean; error?: string }> => {
		return await ipcRenderer.invoke("context-aware-snippets:configure", {
			pythonPath,
			autoBuildSourcePath,
		});
	},

	onSnippetStreamChunk: (callback: (chunk: string) => void) =>
		createIpcListener<[string]>("context-aware-snippets:stream-chunk", callback),

	onSnippetStatus: (callback: (status: string) => void) =>
		createIpcListener<[string]>("context-aware-snippets:status", callback),

	onSnippetError: (callback: (error: string) => void) =>
		createIpcListener<[string]>("context-aware-snippets:error", callback),

	onSnippetComplete: (callback: (result: ContextAwareSnippetResult) => void) =>
		createIpcListener<[ContextAwareSnippetResult]>(
			"context-aware-snippets:complete",
			callback,
		),
});

// Export individual functions for backward compatibility
export const generateContextAwareSnippet =
	createContextAwareSnippetsAPI().generateContextAwareSnippet;
export const cancelSnippetGeneration =
	createContextAwareSnippetsAPI().cancelSnippetGeneration;
export const configureSnippetsService =
	createContextAwareSnippetsAPI().configureSnippetsService;
export const onSnippetStreamChunk =
	createContextAwareSnippetsAPI().onSnippetStreamChunk;
export const onSnippetStatus = createContextAwareSnippetsAPI().onSnippetStatus;
export const onSnippetError = createContextAwareSnippetsAPI().onSnippetError;
export const onSnippetComplete =
	createContextAwareSnippetsAPI().onSnippetComplete;

// Note: This module exports functions that are integrated into the main ElectronAPI
// The contextBridge exposure is handled in the main preload/index.ts file
