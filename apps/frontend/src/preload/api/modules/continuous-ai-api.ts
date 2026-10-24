/**
 * Continuous AI API
 *
 * Renderer-side bridge to the Continuous AI daemon (CI/CD watcher, dependency
 * sentinel, issue responder, PR reviewer).
 *
 * `continuous-ai-handlers.ts` answers on seven channels and
 * `continuous-ai-store.ts` calls all of them, but no bridge joined the two.
 * The visible consequence was in Settings: `setConfig` and `setModuleConfig`
 * fire `updateConfig` through an optional chain, so a missing bridge made the
 * whole expression short-circuit — every toggle looked applied and none of it
 * ever reached the daemon.
 */

import type {
	ContinuousAIConfig,
	ContinuousAIStatus,
	DaemonEvent,
} from "../../../shared/types/continuous-ai";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

/** Shared shape of the daemon's imperative replies. */
export interface ContinuousAIResult {
	success: boolean;
	error?: string;
}

export interface ContinuousAIAPI {
	start: (
		config: ContinuousAIConfig,
		projectPath?: string,
	) => Promise<ContinuousAIResult>;
	stop: () => Promise<ContinuousAIResult>;
	getStatus: (projectPath?: string) => Promise<ContinuousAIStatus | null>;
	updateConfig: (
		config: ContinuousAIConfig,
		projectPath?: string,
	) => Promise<ContinuousAIResult>;
	approveAction: (actionId: string) => Promise<ContinuousAIResult>;
	rejectAction: (actionId: string) => Promise<ContinuousAIResult>;
	isRunning: () => Promise<boolean>;

	onEvent: (callback: (event: DaemonEvent) => void) => () => void;
}

export const createContinuousAIAPI = (): ContinuousAIAPI => ({
	start: (config, projectPath) =>
		invokeIpc<ContinuousAIResult>(IPC_CHANNELS.CONTINUOUS_AI_START, config, projectPath),

	stop: () => invokeIpc<ContinuousAIResult>(IPC_CHANNELS.CONTINUOUS_AI_STOP),

	// The store asks for `getStatus`; the channel is named `continuousAI:status`.
	getStatus: (projectPath) =>
		invokeIpc<ContinuousAIStatus | null>(IPC_CHANNELS.CONTINUOUS_AI_STATUS, projectPath),

	updateConfig: (config, projectPath) =>
		invokeIpc<ContinuousAIResult>(
			IPC_CHANNELS.CONTINUOUS_AI_UPDATE_CONFIG,
			config,
			projectPath,
		),

	approveAction: (actionId) =>
		invokeIpc<ContinuousAIResult>(IPC_CHANNELS.CONTINUOUS_AI_APPROVE_ACTION, actionId),

	rejectAction: (actionId) =>
		invokeIpc<ContinuousAIResult>(IPC_CHANNELS.CONTINUOUS_AI_REJECT_ACTION, actionId),

	isRunning: () => invokeIpc<boolean>(IPC_CHANNELS.CONTINUOUS_AI_IS_RUNNING),

	onEvent: (callback) =>
		createIpcListener<[DaemonEvent]>(IPC_CHANNELS.CONTINUOUS_AI_EVENT, (payload) =>
			callback(payload),
		),
});
