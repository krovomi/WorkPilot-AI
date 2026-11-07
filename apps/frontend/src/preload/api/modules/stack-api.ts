/**
 * Stacked tasks (F6): start a task from a blocker's branch and keep it there.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { IPCResult } from "../../../shared/types";
import type { StackStatus } from "../../../shared/utils/task-stack";
import { invokeIpc } from "./ipc-utils";

export interface StackUpdateOutcome {
	outcome: "rebased" | "moved_to_base" | "metadata_only" | "up_to_date";
	conflicts?: string[];
	prNote?: string;
	metadata?: Record<string, unknown>;
}

export interface StackAPI {
	stackTaskOn: (
		taskId: string,
		parentTaskId: string,
	) => Promise<IPCResult<Record<string, unknown>>>;
	getTaskStackStatus: (taskId: string) => Promise<IPCResult<StackStatus>>;
	updateTaskStack: (taskId: string) => Promise<IPCResult<StackUpdateOutcome>>;
}

export function createStackAPI(): StackAPI {
	return {
		stackTaskOn: (taskId: string, parentTaskId: string) =>
			invokeIpc(IPC_CHANNELS.TASK_STACK_ON, taskId, parentTaskId),
		getTaskStackStatus: (taskId: string) => invokeIpc(IPC_CHANNELS.TASK_STACK_STATUS, taskId),
		updateTaskStack: (taskId: string) => invokeIpc(IPC_CHANNELS.TASK_STACK_UPDATE, taskId),
	};
}
