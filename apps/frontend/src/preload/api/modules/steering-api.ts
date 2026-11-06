/**
 * Steering API module: messages to a running task, and their acknowledgements.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { IPCResult } from "../../../shared/types";
import type { SteeringMessage } from "../../../shared/types/steering";
import { invokeIpc } from "./ipc-utils";

export interface SteeringAPI {
	listTaskSteering: (taskId: string) => Promise<IPCResult<SteeringMessage[]>>;
	sendTaskSteering: (
		taskId: string,
		text: string,
		targetSubtaskId?: string | null,
	) => Promise<IPCResult<SteeringMessage[]>>;
}

export function createSteeringAPI(): SteeringAPI {
	return {
		listTaskSteering: (taskId: string) =>
			invokeIpc(IPC_CHANNELS.TASK_STEERING_LIST, taskId),
		sendTaskSteering: (taskId: string, text: string, targetSubtaskId?: string | null) =>
			invokeIpc(IPC_CHANNELS.TASK_STEERING_SEND, taskId, text, targetSubtaskId ?? null),
	};
}
