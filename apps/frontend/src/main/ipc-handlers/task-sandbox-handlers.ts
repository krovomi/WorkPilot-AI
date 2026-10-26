/**
 * The OS sandbox status of each task: from the build's task events to the
 * card. The checks live in `../task-sandbox.ts`; this file only routes.
 */
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { parseSandboxStatus, taskSandboxes } from "../task-sandbox";
import { safeSendToRenderer } from "./utils";

/** A `SANDBOX_STATUS` task event: stored and shown, never sent to XState. */
export function handleSandboxTaskEvent(
	taskId: string,
	event: { type?: string; sandbox?: unknown },
	projectId: string | undefined,
	getMainWindow: () => BrowserWindow | null,
): boolean {
	if (event.type !== "SANDBOX_STATUS") return false;
	const status = parseSandboxStatus(taskId, event, projectId);
	if (status) {
		taskSandboxes.set(status);
		safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_SANDBOX_STATUS, status);
	}
	return true;
}

export function registerTaskSandboxHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.TASK_SANDBOX_LIST, () => taskSandboxes.list());
}
