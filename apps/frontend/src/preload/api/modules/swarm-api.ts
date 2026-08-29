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
			"swarm:analyze",
			specId,
			config,
		),

	start: (specId, config, projectId) =>
		invokeIpc<SwarmStartResult>("swarm:start", specId, config, projectId),

	cancel: () =>
		invokeIpc<{ success: boolean; cancelled?: boolean }>("swarm:cancel"),

	status: () => invokeIpc<SwarmStatus | null>("swarm:status"),

	onEvent: (callback) =>
		createIpcListener<[SwarmEvent]>("swarm:event", (payload) =>
			callback(payload),
		),

	onLog: (callback) =>
		createIpcListener<[string]>("swarm:log", (payload) => callback(payload)),
});
