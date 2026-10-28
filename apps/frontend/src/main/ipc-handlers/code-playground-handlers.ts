import { type BrowserWindow, ipcMain } from "electron";
import {
	codePlaygroundService,
	type PlaygroundResult,
} from "../code-playground-service";
import { projectStore } from "../project-store";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

/**
 * Register IPC handlers for code playground functionality
 */
export function registerCodePlaygroundHandlers(): void {
	// Handle playground generation requests
	ipcMain.on(
		IPC_CHANNELS.CODE_PLAYGROUND_START,
		async (_, { projectId, idea, playgroundType, sandboxType }) => {
			try {
				const project = projectStore.getProject(projectId);
				if (!project) {
					codePlaygroundService.emit("error", "Project not found");
					return;
				}

				await codePlaygroundService.generate({
					projectDir: project.path,
					idea,
					playgroundType,
					sandboxType,
				});
			} catch (error) {
				console.error("[CodePlayground] Error starting playground:", error);
				codePlaygroundService.emit(
					"error",
					error instanceof Error ? error.message : "Unknown error",
				);
			}
		},
	);

	// Handle cancellation requests
	ipcMain.on(IPC_CHANNELS.CODE_PLAYGROUND_CANCEL, () => {
		codePlaygroundService.cancel();
	});
}

/**
 * Setup event forwarding from code playground service to renderer
 */
export function setupCodePlaygroundEventForwarding(
	getMainWindow: () => BrowserWindow | null,
): void {
	const send = (channel: string, payload: unknown): void => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(channel, payload);
		}
	};

	codePlaygroundService.on("status", (status: string) =>
		send(IPC_CHANNELS.CODE_PLAYGROUND_STATUS, status),
	);
	codePlaygroundService.on("stream-chunk", (chunk: string) =>
		send(IPC_CHANNELS.CODE_PLAYGROUND_STREAM_CHUNK, chunk),
	);
	codePlaygroundService.on("error", (error: string) =>
		send(IPC_CHANNELS.CODE_PLAYGROUND_ERROR, error),
	);
	codePlaygroundService.on("complete", (result: PlaygroundResult) =>
		send(IPC_CHANNELS.CODE_PLAYGROUND_COMPLETE, result),
	);
}
