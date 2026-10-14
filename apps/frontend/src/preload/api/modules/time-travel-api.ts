/**
 * Agent Time Travel API
 *
 * Renderer-side bridge to `time-travel-handlers`: checkpoints, forks and
 * decision scoring. One method per channel; `time-travel-store` used to reach
 * these channels through the generic `invoke` passthrough.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	TimeTravelCheckpointResult,
	TimeTravelCheckpointsResult,
	TimeTravelDecisionHeatmapResult,
	TimeTravelDecisionScoresResult,
	TimeTravelForkContextResult,
	TimeTravelForkResult,
	TimeTravelForksResult,
	TimeTravelResult,
} from "../../../shared/types/ipc";
import type { ForkRequest } from "../../../shared/types/time-travel";
import { invokeIpc } from "./ipc-utils";

/** A fork request; the session it forks is passed alongside. */
export type TimeTravelForkOptions = Omit<ForkRequest, "session_id">;

export interface TimeTravelAPI {
	generateTimeTravelCheckpoints: (
		sessionId: string,
	) => Promise<TimeTravelCheckpointsResult>;
	getTimeTravelCheckpoints: (
		sessionId: string,
	) => Promise<TimeTravelCheckpointsResult>;
	addTimeTravelCheckpoint: (
		sessionId: string,
		stepIndex: number,
		label?: string,
		description?: string,
	) => Promise<TimeTravelCheckpointResult>;
	deleteTimeTravelCheckpoint: (
		sessionId: string,
		checkpointId: string,
	) => Promise<TimeTravelResult>;
	forkTimeTravelSession: (
		sessionId: string,
		options: TimeTravelForkOptions,
	) => Promise<TimeTravelForkResult>;
	listTimeTravelForks: (sessionId?: string) => Promise<TimeTravelForksResult>;
	getTimeTravelForkContext: (
		forkId: string,
	) => Promise<TimeTravelForkContextResult>;
	deleteTimeTravelFork: (forkId: string) => Promise<TimeTravelResult>;
	scoreTimeTravelDecisions: (
		sessionId: string,
	) => Promise<TimeTravelDecisionScoresResult>;
	getTimeTravelDecisionScores: (
		sessionId: string,
	) => Promise<TimeTravelDecisionScoresResult>;
	getTimeTravelDecisionHeatmap: (
		sessionId: string,
	) => Promise<TimeTravelDecisionHeatmapResult>;
}

export const createTimeTravelAPI = (): TimeTravelAPI => ({
	generateTimeTravelCheckpoints: (sessionId) =>
		invokeIpc(IPC_CHANNELS.TIME_TRAVEL_GENERATE_CHECKPOINTS, sessionId),

	getTimeTravelCheckpoints: (sessionId) =>
		invokeIpc(IPC_CHANNELS.TIME_TRAVEL_GET_CHECKPOINTS, sessionId),

	addTimeTravelCheckpoint: (sessionId, stepIndex, label, description) =>
		invokeIpc(
			IPC_CHANNELS.TIME_TRAVEL_ADD_CHECKPOINT,
			sessionId,
			stepIndex,
			label,
			description,
		),

	deleteTimeTravelCheckpoint: (sessionId, checkpointId) =>
		invokeIpc(
			IPC_CHANNELS.TIME_TRAVEL_DELETE_CHECKPOINT,
			sessionId,
			checkpointId,
		),

	forkTimeTravelSession: (sessionId, options) =>
		invokeIpc(IPC_CHANNELS.TIME_TRAVEL_FORK_SESSION, sessionId, options),

	listTimeTravelForks: (sessionId) =>
		invokeIpc(IPC_CHANNELS.TIME_TRAVEL_LIST_FORKS, sessionId),

	getTimeTravelForkContext: (forkId) =>
		invokeIpc(IPC_CHANNELS.TIME_TRAVEL_GET_FORK_CONTEXT, forkId),

	deleteTimeTravelFork: (forkId) =>
		invokeIpc(IPC_CHANNELS.TIME_TRAVEL_DELETE_FORK, forkId),

	scoreTimeTravelDecisions: (sessionId) =>
		invokeIpc(IPC_CHANNELS.TIME_TRAVEL_SCORE_DECISIONS, sessionId),

	getTimeTravelDecisionScores: (sessionId) =>
		invokeIpc(IPC_CHANNELS.TIME_TRAVEL_GET_DECISION_SCORES, sessionId),

	getTimeTravelDecisionHeatmap: (sessionId) =>
		invokeIpc(IPC_CHANNELS.TIME_TRAVEL_GET_DECISION_HEATMAP, sessionId),
});
