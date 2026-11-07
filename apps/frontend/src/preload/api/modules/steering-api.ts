/**
 * Steering API module: messages to a running task, and their acknowledgements.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { IPCResult } from "../../../shared/types";
import type {
	PointedElementSummary,
	PointedSendItem,
} from "../../../shared/types/preview-point";
import type { SteeringMessage } from "../../../shared/types/steering";
import { invokeIpc } from "./ipc-utils";

export interface SteeringAPI {
	listTaskSteering: (taskId: string) => Promise<IPCResult<SteeringMessage[]>>;
	sendTaskSteering: (
		taskId: string,
		text: string,
		targetSubtaskId?: string | null,
	) => Promise<IPCResult<SteeringMessage[]>>;
	/** Wait for a click in the preview (the `<webview>`'s id) and describe the element. */
	startPreviewPoint: (
		taskId: string,
		webContentsId: number,
	) => Promise<IPCResult<PointedElementSummary | null>>;
	cancelPreviewPoint: (webContentsId: number) => Promise<IPCResult<boolean>>;
	discardPreviewPoint: (taskId: string, elementId: string) => Promise<IPCResult<boolean>>;
	sendPreviewPoints: (
		taskId: string,
		items: PointedSendItem[],
	) => Promise<IPCResult<SteeringMessage[]>>;
}

export function createSteeringAPI(): SteeringAPI {
	return {
		listTaskSteering: (taskId: string) =>
			invokeIpc(IPC_CHANNELS.TASK_STEERING_LIST, taskId),
		sendTaskSteering: (taskId: string, text: string, targetSubtaskId?: string | null) =>
			invokeIpc(IPC_CHANNELS.TASK_STEERING_SEND, taskId, text, targetSubtaskId ?? null),
		startPreviewPoint: (taskId: string, webContentsId: number) =>
			invokeIpc(IPC_CHANNELS.TASK_PREVIEW_POINT_START, taskId, webContentsId),
		cancelPreviewPoint: (webContentsId: number) =>
			invokeIpc(IPC_CHANNELS.TASK_PREVIEW_POINT_CANCEL, webContentsId),
		discardPreviewPoint: (taskId: string, elementId: string) =>
			invokeIpc(IPC_CHANNELS.TASK_PREVIEW_POINT_DISCARD, taskId, elementId),
		sendPreviewPoints: (taskId: string, items: PointedSendItem[]) =>
			invokeIpc(IPC_CHANNELS.TASK_PREVIEW_POINT_SEND, taskId, items),
	};
}
