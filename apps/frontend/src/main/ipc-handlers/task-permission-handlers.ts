/**
 * ACP permission questions: from the build's task events to the card, and the
 * person's answer back to the build's stdin. The checks live in
 * `../task-permissions.ts`; this file only routes.
 */
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { TaskPermissionAnswerResult } from "../../shared/types/task-permission";
import type { AgentManager } from "../agent";
import { notificationService } from "../notification-service";
import {
	parsePermissionRequest,
	resolvedRequestId,
	taskPermissions,
} from "../task-permissions";
import { findTaskAndProject } from "./task/shared";
import { safeSendToRenderer } from "./utils";

export const PERMISSION_EVENT_TYPES = new Set(["PERMISSION_REQUESTED", "PERMISSION_RESOLVED"]);

/**
 * A permission task event: shown or withdrawn, never sent to XState (it is
 * not a state the task reached). True when the event was one.
 */
export function handlePermissionTaskEvent(
	taskId: string,
	event: { type?: string; request?: unknown; requestId?: unknown },
	projectId: string | undefined,
	getMainWindow: () => BrowserWindow | null,
): boolean {
	if (!event.type || !PERMISSION_EVENT_TYPES.has(event.type)) return false;
	if (event.type === "PERMISSION_REQUESTED") {
		const request = parsePermissionRequest(taskId, event, projectId);
		if (!request) return true;
		taskPermissions.add(request);
		safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_PERMISSION_REQUEST, request);
		const { task, project } = findTaskAndProject(taskId, projectId);
		notificationService.notify({
			kind: "permission",
			taskId,
			projectId: project?.id ?? projectId ?? "",
			taskTitle: task?.title ?? taskId,
		});
		return true;
	}
	const requestId = resolvedRequestId(event);
	if (requestId && taskPermissions.remove(taskId, requestId)) {
		safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_PERMISSION_CLEARED, taskId, requestId);
	}
	return true;
}

/** The build is gone: its questions can no longer be answered. */
export function clearTaskPermissions(
	taskId: string,
	getMainWindow: () => BrowserWindow | null,
): void {
	for (const request of taskPermissions.clearTask(taskId)) {
		safeSendToRenderer(
			getMainWindow,
			IPC_CHANNELS.TASK_PERMISSION_CLEARED,
			taskId,
			request.requestId,
		);
	}
}

export function registerTaskPermissionHandlers(agentManager: AgentManager): void {
	ipcMain.handle(IPC_CHANNELS.TASK_PERMISSION_LIST, () => taskPermissions.list());
	ipcMain.handle(
		IPC_CHANNELS.TASK_PERMISSION_ANSWER,
		(_event, taskId: unknown, requestId: unknown, optionId: unknown): TaskPermissionAnswerResult => {
			const checked = taskPermissions.answer(taskId, requestId, optionId);
			if (!("line" in checked)) return checked;
			if (!agentManager.writeToTaskStdin(taskId as string, checked.line)) {
				return { ok: false, reason: "process_gone" };
			}
			return { ok: true };
		},
	);
}
