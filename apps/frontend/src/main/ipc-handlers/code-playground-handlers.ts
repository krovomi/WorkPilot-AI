import { type BrowserWindow, ipcMain } from "electron";
import {
	codePlaygroundService,
	type PlaygroundResult,
} from "../code-playground-service";
import { projectStore } from "../project-store";

/**
 * Register IPC handlers for code playground functionality
 */
export function registerCodePlaygroundHandlers(): void {
	// Handle playground generation requests
	ipcMain.on(
		"code-playground:start",
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
	ipcMain.on("code-playground:cancel", () => {
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
		send("code-playground:status", status),
	);
	codePlaygroundService.on("stream-chunk", (chunk: string) =>
		send("code-playground:stream-chunk", chunk),
	);
	codePlaygroundService.on("error", (error: string) =>
		send("code-playground:error", error),
	);
	codePlaygroundService.on("complete", (result: PlaygroundResult) =>
		send("code-playground:complete", result),
	);
}
