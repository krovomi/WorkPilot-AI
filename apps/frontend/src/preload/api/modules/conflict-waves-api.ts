/**
 * Execution waves across specs (#358): the main process reads the plans and
 * worktrees and runs the planner. The renderer names a project and its tasks
 * by id; the waves are started through the ordinary task status path.
 */
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult } from "../../../shared/types";
import type {
	ExecutionWavePlan,
	ExecutionWavePlanRequest,
	SavedWaveRunResult,
	WaveAdvanceWhen,
	WaveRunHistory,
	WaveRunOutcome,
	WaveRunState,
} from "../../../shared/types/conflict-waves";
import type {
	ServerWaveHistory,
	ServerWavePlan,
	ServerWaveRunAnswer,
} from "../../../shared/types/server-conflict-waves";
import { invokeIpc } from "./ipc-utils";

export interface ConflictWavesAPI {
	planExecutionWaves: (
		request: ExecutionWavePlanRequest,
	) => Promise<IPCResult<ExecutionWavePlan>>;
	/** The run saved in the project, to resume after a restart. */
	loadExecutionWaveRun: (projectId: string) => Promise<IPCResult<SavedWaveRunResult>>;
	saveExecutionWaveRun: (state: WaveRunState) => Promise<IPCResult<void>>;
	/** Forgets the saved run; with an outcome, records it in the run history first. */
	clearExecutionWaveRun: (
		projectId: string,
		outcome?: WaveRunOutcome,
	) => Promise<IPCResult<void>>;
	/** The project's run history (sprint metrics), newest first. */
	loadExecutionWaveHistory: (projectId: string) => Promise<IPCResult<WaveRunHistory>>;
	/** A server project's waves, as the server plans them now. */
	getServerWavePlan: (projectId: string) => Promise<IPCResult<ServerWavePlan>>;
	/** The server's run going on, if any. */
	getServerWaveRun: (projectId: string) => Promise<IPCResult<ServerWaveRunAnswer>>;
	/** Plans the backlog on the server and starts its first wave. */
	startServerWaveRun: (
		projectId: string,
		advanceWhen: WaveAdvanceWhen,
	) => Promise<IPCResult<ServerWaveRunAnswer>>;
	/** Starts what may start now on the server; the next wave once this one settled. */
	stepServerWaveRun: (projectId: string) => Promise<IPCResult<ServerWaveRunAnswer>>;
	/** Ends the server's run; the cards it started keep running. */
	stopServerWaveRun: (projectId: string) => Promise<IPCResult<ServerWaveRunAnswer>>;
	/** The server's run history and merge conflict times, counted over its window. */
	getServerWaveHistory: (projectId: string) => Promise<IPCResult<ServerWaveHistory>>;
}

export function createConflictWavesAPI(): ConflictWavesAPI {
	return {
		planExecutionWaves: (request) =>
			invokeIpc(IPC_CHANNELS.CONFLICT_WAVES_PLAN, request),
		loadExecutionWaveRun: (projectId) =>
			invokeIpc(IPC_CHANNELS.CONFLICT_WAVES_RUN_LOAD, projectId),
		saveExecutionWaveRun: (state) => invokeIpc(IPC_CHANNELS.CONFLICT_WAVES_RUN_SAVE, state),
		clearExecutionWaveRun: (projectId, outcome) =>
			invokeIpc(IPC_CHANNELS.CONFLICT_WAVES_RUN_CLEAR, projectId, outcome),
		loadExecutionWaveHistory: (projectId) =>
			invokeIpc(IPC_CHANNELS.CONFLICT_WAVES_HISTORY, projectId),
		getServerWavePlan: (projectId) => invokeIpc(IPC_CHANNELS.CONFLICT_WAVES_SERVER_PLAN, projectId),
		getServerWaveRun: (projectId) => invokeIpc(IPC_CHANNELS.CONFLICT_WAVES_SERVER_RUN, projectId),
		startServerWaveRun: (projectId, advanceWhen) =>
			invokeIpc(IPC_CHANNELS.CONFLICT_WAVES_SERVER_START, projectId, advanceWhen),
		stepServerWaveRun: (projectId) => invokeIpc(IPC_CHANNELS.CONFLICT_WAVES_SERVER_STEP, projectId),
		stopServerWaveRun: (projectId) => invokeIpc(IPC_CHANNELS.CONFLICT_WAVES_SERVER_STOP, projectId),
		getServerWaveHistory: (projectId) => invokeIpc(IPC_CHANNELS.CONFLICT_WAVES_SERVER_HISTORY, projectId),
	};
}
