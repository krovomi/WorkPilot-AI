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
	clearExecutionWaveRun: (projectId: string) => Promise<IPCResult<void>>;
}

export function createConflictWavesAPI(): ConflictWavesAPI {
	return {
		planExecutionWaves: (request) =>
			invokeIpc(IPC_CHANNELS.CONFLICT_WAVES_PLAN, request),
		loadExecutionWaveRun: (projectId) =>
			invokeIpc(IPC_CHANNELS.CONFLICT_WAVES_RUN_LOAD, projectId),
		saveExecutionWaveRun: (state) => invokeIpc(IPC_CHANNELS.CONFLICT_WAVES_RUN_SAVE, state),
		clearExecutionWaveRun: (projectId) =>
			invokeIpc(IPC_CHANNELS.CONFLICT_WAVES_RUN_CLEAR, projectId),
	};
}
