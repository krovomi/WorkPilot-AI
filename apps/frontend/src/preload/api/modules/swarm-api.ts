/**
 * Swarm API
 *
 * Renderer-side bridge to the swarm runner (parallel subtask execution).
 *
 * `swarm-handlers.ts` has always answered on these channels and
 * `swarm-store.ts` has always called them — this module is the bridge that
 * was missing between the two, so every call reached an `electronAPI.swarm`
 * that did not exist.
 */

import type {
	ParallelismStats,
	SwarmAnalysisEvent,
	SwarmConfig,
	SwarmEvent,
	SwarmStatus,
} from "../../../shared/types/swarm";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

/** What `swarm:start` reports back once the runner process is spawned. */
export interface SwarmStartResult {
	success: boolean;
	pid?: number;
	error?: string;
}

export interface SwarmAPI {
	/** Dependency analysis only — returns the wave plan without executing it. */
	analyze: (
		specId: string,
		config: SwarmConfig,
	) => Promise<SwarmAnalysisEvent & { parallelismStats: ParallelismStats }>;
	/** Spawn the runner. Progress arrives through `onEvent` / `onLog`. */
	start: (
		specId: string,
		config: SwarmConfig,
		projectId?: string,
	) => Promise<SwarmStartResult>;
	cancel: () => Promise<{ success: boolean; cancelled?: boolean }>;
	status: () => Promise<SwarmStatus | null>;

	onEvent: (callback: (event: SwarmEvent) => void) => () => void;
	onLog: (callback: (line: string) => void) => () => void;
}

export const createSwarmAPI = (): SwarmAPI => ({
	analyze: (specId, config) =>
		invokeIpc<SwarmAnalysisEvent & { parallelismStats: ParallelismStats }>(
			IPC_CHANNELS.SWARM_ANALYZE,
			specId,
			config,
		),

	start: (specId, config, projectId) =>
		invokeIpc<SwarmStartResult>(IPC_CHANNELS.SWARM_START, specId, config, projectId),

	cancel: () =>
		invokeIpc<{ success: boolean; cancelled?: boolean }>(IPC_CHANNELS.SWARM_CANCEL),

	status: () => invokeIpc<SwarmStatus | null>(IPC_CHANNELS.SWARM_STATUS),

	onEvent: (callback) =>
		createIpcListener<[SwarmEvent]>(IPC_CHANNELS.SWARM_EVENT, (payload) =>
			callback(payload),
		),

	onLog: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.SWARM_LOG, (payload) => callback(payload)),
});
