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
} from "../../../shared/types/conflict-waves";
import { invokeIpc } from "./ipc-utils";

export interface ConflictWavesAPI {
	planExecutionWaves: (
		request: ExecutionWavePlanRequest,
	) => Promise<IPCResult<ExecutionWavePlan>>;
}

export function createConflictWavesAPI(): ConflictWavesAPI {
	return {
		planExecutionWaves: (request) =>
			invokeIpc(IPC_CHANNELS.CONFLICT_WAVES_PLAN, request),
	};
}
