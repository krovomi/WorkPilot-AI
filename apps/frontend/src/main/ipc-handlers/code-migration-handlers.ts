import { type BrowserWindow, ipcMain } from "electron";
import {
	type CodeMigrationRequest,
	codeMigrationService,
} from "../code-migration-service";
import { IPC_CHANNELS } from "../../shared/constants";

export function registerCodeMigrationHandlers(): void {
	ipcMain.handle(
		"codeMigration:start",
		async (_event, request: CodeMigrationRequest) => {
			try {
				await codeMigrationService.startMigration(request);
				return { success: true };
			} catch (error) {
				console.error("[CodeMigration] Start error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	ipcMain.handle("codeMigration:cancel", async () => {
		try {
			const cancelled = codeMigrationService.cancel();
			return { success: true, cancelled };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});

	ipcMain.handle(
		"codeMigration:configure",
		async (
			_event,
			config: { pythonPath?: string; autoBuildSourcePath?: string },
		) => {
			try {
				codeMigrationService.configure(
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
export function setupCodeMigrationEventForwarding(
	getMainWindow: () => BrowserWindow | null,
): void {
	const send = (channel: string, payload: unknown): void => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(channel, payload);
		}
	};

	codeMigrationService.on("status", (status: string) =>
		send(IPC_CHANNELS.CODE_MIGRATION_STATUS, status),
	);
	codeMigrationService.on("stream-chunk", (chunk: string) =>
		send(IPC_CHANNELS.CODE_MIGRATION_STREAM_CHUNK, chunk),
	);
	codeMigrationService.on("error", (error: string) =>
		send(IPC_CHANNELS.CODE_MIGRATION_ERROR, error),
	);
	codeMigrationService.on("complete", (result) =>
		send(IPC_CHANNELS.CODE_MIGRATION_COMPLETE, result),
	);
	codeMigrationService.on("task-progress", (progress) =>
		send(IPC_CHANNELS.CODE_MIGRATION_TASK_PROGRESS, progress),
	);
}
