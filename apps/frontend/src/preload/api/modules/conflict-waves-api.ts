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
	WaveRunHistory,
	WaveRunOutcome,
	WaveRunState,
} from "../../../shared/types/conflict-waves";
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
	};
}
