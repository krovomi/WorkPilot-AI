/**
 * Auto-Refactor API module
 *
 * Provides API methods for interacting with the Auto-Refactor Agent functionality
 */

import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface AutoRefactorRequest {
	projectDir: string;
	model?: string;
	thinkingLevel?: string;
	autoExecute?: boolean;
}

export interface AutoRefactorResult {
	analysis: {
		status: string;
		analysis: unknown;
		files_analyzed: number;
	};
	plan: {
		status: string;
		plan: unknown;
	};
	execution: {
		status: string;
		execution: unknown;
		auto_executed: boolean;
	};
	summary: {
		issues_found: number;
		files_analyzed: number;
		refactoring_items: number;
		quick_wins: number;
		estimated_effort: string;
		risk_level: string;
	};
}

export interface AutoRefactorAPI {
	// Methods
	startAutoRefactor: (
		request: AutoRefactorRequest,
	) => Promise<{ success: boolean; error?: string }>;
	cancelAutoRefactor: () => Promise<{
		success: boolean;
		cancelled: boolean;
		error?: string;
	}>;

	// Event listeners
	onAutoRefactorStatus: (callback: (status: string) => void) => () => void;
	onAutoRefactorStreamChunk: (callback: (chunk: string) => void) => () => void;
	onAutoRefactorError: (callback: (error: string) => void) => () => void;
	onAutoRefactorComplete: (
		callback: (result: AutoRefactorResult) => void,
	) => () => void;
	onAutoRefactorExecutionComplete: (
		callback: (result: unknown) => void,
	) => () => void;
}

/**
 * Create the Auto-Refactor API object
 */
export function createAutoRefactorAPI(): AutoRefactorAPI {
	return {
		// Methods
		startAutoRefactor: (request: AutoRefactorRequest) =>
			invokeIpc(IPC_CHANNELS.AUTO_REFACTOR_START, request),

		cancelAutoRefactor: () => invokeIpc(IPC_CHANNELS.AUTO_REFACTOR_CANCEL),

		// Event listeners
		onAutoRefactorStatus: (callback: (status: string) => void) =>
			createIpcListener(IPC_CHANNELS.AUTO_REFACTOR_STATUS, callback),

		onAutoRefactorStreamChunk: (callback: (chunk: string) => void) =>
			createIpcListener(IPC_CHANNELS.AUTO_REFACTOR_STREAM_CHUNK, callback),

		onAutoRefactorError: (callback: (error: string) => void) =>
			createIpcListener(IPC_CHANNELS.AUTO_REFACTOR_ERROR, callback),

		onAutoRefactorComplete: (callback: (result: AutoRefactorResult) => void) =>
			createIpcListener(IPC_CHANNELS.AUTO_REFACTOR_COMPLETE, callback),

		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		onAutoRefactorExecutionComplete: (callback: (result: any) => void) =>
			createIpcListener(IPC_CHANNELS.AUTO_REFACTOR_EXECUTION_COMPLETE, callback),
	};
}
