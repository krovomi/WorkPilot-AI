import { type BrowserWindow, ipcMain } from "electron";
import {
	type AutoRefactorRequest,
	autoRefactorService,
} from "../auto-refactor-service";

/**
 * Register IPC handlers for Auto-Refactor functionality
 */
export function registerAutoRefactorHandlers(): void {
	// Start auto-refactor analysis
	ipcMain.handle(
		"auto-refactor:start",
		async (_event, request: AutoRefactorRequest) => {
			try {
				await autoRefactorService.analyze(request);
				return { success: true };
			} catch (error) {
				console.error("[AutoRefactor] Start error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Cancel auto-refactor analysis
	ipcMain.handle("auto-refactor:cancel", async () => {
		try {
			const cancelled = autoRefactorService.cancel();
			return { success: true, cancelled };
		} catch (error) {
			console.error("[AutoRefactor] Cancel error:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});

	// Configure service paths
	ipcMain.handle(
		"auto-refactor:configure",
		async (
			_event,
			config: { pythonPath?: string; autoBuildSourcePath?: string },
		) => {
			try {
				autoRefactorService.configure(
					config.pythonPath,
					config.autoBuildSourcePath,
				);
				return { success: true };
			} catch (error) {
				console.error("[AutoRefactor] Configure error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);
}

/** Set once the service's listeners are attached; see below. */
let forwardingRegistered = false;

/**
 * Setup event listeners for Auto-Refactor service events
 * These events are forwarded to the renderer process
 *
 * Attaching twice would send every event twice, so a second call is a no-op.
 * The `"error"` listener also matters to the main process itself: the service
 * emits it from child-process callbacks, and an `EventEmitter` with no
 * `"error"` listener throws.
 */
export function setupAutoRefactorEventForwarding(
	getMainWindow: () => BrowserWindow | null,
): void {
	if (forwardingRegistered) return;
	forwardingRegistered = true;

	const send = (channel: string, payload: unknown): void => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(channel, payload);
		}
	};

	autoRefactorService.on("status", (status: string) =>
		send("auto-refactor:status", status),
	);
	autoRefactorService.on("stream-chunk", (chunk: string) =>
		send("auto-refactor:stream-chunk", chunk),
	);
	autoRefactorService.on("error", (error: string) =>
		send("auto-refactor:error", error),
	);
	// Completion with the analysis result
	autoRefactorService.on("complete", (result) =>
		send("auto-refactor:complete", result),
	);
	// Execution completion (if auto-executed)
	autoRefactorService.on("execution-complete", (result) =>
		send("auto-refactor:execution-complete", result),
	);
}
