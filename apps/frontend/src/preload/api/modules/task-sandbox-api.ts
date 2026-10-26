/**
 * Whether each task's commands run in the OS sandbox, for the task card.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { TaskSandboxStatus } from "../../../shared/types/task-sandbox";
import { createIpcListener, invokeIpc } from "./ipc-utils";

export interface TaskSandboxAPI {
	listTaskSandboxes: () => Promise<TaskSandboxStatus[]>;
	onTaskSandboxStatus: (callback: (status: TaskSandboxStatus) => void) => () => void;
}

export const createTaskSandboxAPI = (): TaskSandboxAPI => ({
	listTaskSandboxes: () => invokeIpc<TaskSandboxStatus[]>(IPC_CHANNELS.TASK_SANDBOX_LIST),
	onTaskSandboxStatus: (callback) => createIpcListener(IPC_CHANNELS.TASK_SANDBOX_STATUS, callback),
});
