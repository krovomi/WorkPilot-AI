import { type BrowserWindow, ipcMain } from "electron";
import {
	type DocumentationAgentRequest,
	documentationAgentService,
} from "../documentation-agent-service";
import { IPC_CHANNELS } from "../../shared/constants";

export function registerDocumentationAgentHandlers(): void {
	ipcMain.handle(
		"documentationAgent:generate",
		async (_event, request: DocumentationAgentRequest) => {
			try {
				await documentationAgentService.generateDocs(request);
				return { success: true };
			} catch (error) {
				console.error("[DocAgent] Generate error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	ipcMain.handle("documentationAgent:cancel", async () => {
		try {
			const cancelled = documentationAgentService.cancel();
			return { success: true, cancelled };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});

	ipcMain.handle(
		"documentationAgent:configure",
		async (
			_event,
			config: { pythonPath?: string; autoBuildSourcePath?: string },
		) => {
			try {
				documentationAgentService.configure(
					config.pythonPath,
					config.autoBuildSourcePath,
				);
				return { success: true };
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);
}

/**
 * Forward the service's events to the renderer, on the `IPC_CHANNELS` the
 * preload listens on.
 */
export function setupDocumentationAgentEventForwarding(
	getMainWindow: () => BrowserWindow | null,
): void {
	const send = (channel: string, payload: unknown): void => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(channel, payload);
		}
	};

	documentationAgentService.on("status", (status: string) =>
		send(IPC_CHANNELS.DOCUMENTATION_AGENT_STATUS, status),
	);
	documentationAgentService.on("stream-chunk", (chunk: string) =>
		send(IPC_CHANNELS.DOCUMENTATION_AGENT_STREAM_CHUNK, chunk),
	);
	documentationAgentService.on("error", (error: string) =>
		send(IPC_CHANNELS.DOCUMENTATION_AGENT_ERROR, error),
	);
	documentationAgentService.on("complete", (result) =>
		send(IPC_CHANNELS.DOCUMENTATION_AGENT_COMPLETE, result),
	);
}
