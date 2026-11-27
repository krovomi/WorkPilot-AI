/**
 * Whether each task's commands run in the OS sandbox, for the task card.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { MicrovmStatus, TaskSandboxStatus } from "../../../shared/types/task-sandbox";
import { createIpcListener, invokeIpc } from "./ipc-utils";

export interface TaskSandboxAPI {
	listTaskSandboxes: () => Promise<TaskSandboxStatus[]>;
	onTaskSandboxStatus: (callback: (status: TaskSandboxStatus) => void) => () => void;
	getMicrovmStatus: () => Promise<MicrovmStatus>;
}

export const createTaskSandboxAPI = (): TaskSandboxAPI => ({
	listTaskSandboxes: () => invokeIpc<TaskSandboxStatus[]>(IPC_CHANNELS.TASK_SANDBOX_LIST),
	onTaskSandboxStatus: (callback) => createIpcListener(IPC_CHANNELS.TASK_SANDBOX_STATUS, callback),
	getMicrovmStatus: () => invokeIpc<MicrovmStatus>(IPC_CHANNELS.TASK_SANDBOX_MICROVM_STATUS),
});
