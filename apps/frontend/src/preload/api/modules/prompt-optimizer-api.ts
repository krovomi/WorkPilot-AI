import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	PromptOptimizerAgentType,
	PromptOptimizerError,
	PromptOptimizerResult,
	PromptOptimizerStatus,
} from "../../../shared/types/prompt-optimizer";
import {
	createIpcListener,
	type IpcListenerCleanup,
	sendIpc,
} from "./ipc-utils";

export type { PromptOptimizerResult } from "../../../shared/types/prompt-optimizer";

/**
 * Prompt Optimizer API operations
 */
export interface PromptOptimizerAPI {
	// Operations
	optimizePrompt: (
		projectId: string,
		prompt: string,
		agentType: PromptOptimizerAgentType,
	) => void;
	cancelPromptOptimization: () => void;

	// Event Listeners
	onPromptOptimizerStreamChunk: (
		callback: (chunk: string) => void,
	) => IpcListenerCleanup;
	onPromptOptimizerStatus: (
		callback: (status: PromptOptimizerStatus) => void,
	) => IpcListenerCleanup;
	onPromptOptimizerError: (
		callback: (error: PromptOptimizerError) => void,
	) => IpcListenerCleanup;
	onPromptOptimizerComplete: (
		callback: (result: PromptOptimizerResult) => void,
	) => IpcListenerCleanup;
}

/**
 * Creates the Prompt Optimizer API implementation
 */
export const createPromptOptimizerAPI = (): PromptOptimizerAPI => ({
	// Operations
	optimizePrompt: (
		projectId: string,
		prompt: string,
		agentType: PromptOptimizerAgentType,
	): void =>
		sendIpc(
			IPC_CHANNELS.PROMPT_OPTIMIZER_OPTIMIZE,
			projectId,
			prompt,
			agentType,
		),

	cancelPromptOptimization: (): void =>
		sendIpc(IPC_CHANNELS.PROMPT_OPTIMIZER_CANCEL),

	// Event Listeners
	onPromptOptimizerStreamChunk: (
		callback: (chunk: string) => void,
	): IpcListenerCleanup =>
		createIpcListener(IPC_CHANNELS.PROMPT_OPTIMIZER_STREAM_CHUNK, callback),

	onPromptOptimizerStatus: (
		callback: (status: PromptOptimizerStatus) => void,
	): IpcListenerCleanup =>
		createIpcListener(IPC_CHANNELS.PROMPT_OPTIMIZER_STATUS, callback),

	onPromptOptimizerError: (
		callback: (error: PromptOptimizerError) => void,
	): IpcListenerCleanup =>
		createIpcListener(IPC_CHANNELS.PROMPT_OPTIMIZER_ERROR, callback),

	onPromptOptimizerComplete: (
		callback: (result: PromptOptimizerResult) => void,
	): IpcListenerCleanup =>
		createIpcListener(IPC_CHANNELS.PROMPT_OPTIMIZER_COMPLETE, callback),
});
