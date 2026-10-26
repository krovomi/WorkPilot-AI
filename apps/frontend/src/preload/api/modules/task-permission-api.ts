/**
 * The questions ACP agents ask before they act, for the task card: the ones
 * waiting now, the person's answer, and the stream of new and withdrawn ones.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	TaskPermissionAnswerResult,
	TaskPermissionRequest,
} from "../../../shared/types/task-permission";
import { createIpcListener, invokeIpc } from "./ipc-utils";

export interface TaskPermissionAPI {
	listTaskPermissions: () => Promise<TaskPermissionRequest[]>;
	answerTaskPermission: (
		taskId: string,
		requestId: string,
		optionId: string,
	) => Promise<TaskPermissionAnswerResult>;
	onTaskPermissionRequest: (callback: (request: TaskPermissionRequest) => void) => () => void;
	onTaskPermissionCleared: (callback: (taskId: string, requestId: string) => void) => () => void;
}

export const createTaskPermissionAPI = (): TaskPermissionAPI => ({
	listTaskPermissions: () => invokeIpc<TaskPermissionRequest[]>(IPC_CHANNELS.TASK_PERMISSION_LIST),
	answerTaskPermission: (taskId, requestId, optionId) =>
		invokeIpc<TaskPermissionAnswerResult>(
			IPC_CHANNELS.TASK_PERMISSION_ANSWER,
			taskId,
			requestId,
			optionId,
		),
	onTaskPermissionRequest: (callback) =>
		createIpcListener(IPC_CHANNELS.TASK_PERMISSION_REQUEST, callback),
	onTaskPermissionCleared: (callback) =>
		createIpcListener(IPC_CHANNELS.TASK_PERMISSION_CLEARED, callback),
});
