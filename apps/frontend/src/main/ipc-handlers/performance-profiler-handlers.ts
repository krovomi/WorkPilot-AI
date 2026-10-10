import { type BrowserWindow, ipcMain } from "electron";
import {
	type PerformanceProfilerRequest,
	performanceProfilerService,
} from "../performance-profiler-service";
import { IPC_CHANNELS } from "../../shared/constants";

export function registerPerformanceProfilerHandlers(): void {
	ipcMain.handle(
		"performanceProfiler:start",
		async (_event, request: PerformanceProfilerRequest) => {
			try {
				await performanceProfilerService.startProfiling(request);
				return { success: true };
			} catch (error) {
				console.error("[PerfProfiler] Start error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	ipcMain.handle("performanceProfiler:cancel", async () => {
		try {
			const cancelled = performanceProfilerService.cancel();
			return { success: true, cancelled };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});

	ipcMain.handle(
		"performanceProfiler:configure",
		async (
			_event,
			config: { pythonPath?: string; autoBuildSourcePath?: string },
		) => {
			try {
				performanceProfilerService.configure(
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
export function setupPerformanceProfilerEventForwarding(
	getMainWindow: () => BrowserWindow | null,
): void {
	const send = (channel: string, payload: unknown): void => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(channel, payload);
		}
	};

	performanceProfilerService.on("status", (status: string) =>
		send(IPC_CHANNELS.PERFORMANCE_PROFILER_STATUS, status),
	);
	performanceProfilerService.on("stream-chunk", (chunk: string) =>
		send(IPC_CHANNELS.PERFORMANCE_PROFILER_STREAM_CHUNK, chunk),
	);
	performanceProfilerService.on("error", (error: string) =>
		send(IPC_CHANNELS.PERFORMANCE_PROFILER_ERROR, error),
	);
	performanceProfilerService.on("complete", (result) =>
		send(IPC_CHANNELS.PERFORMANCE_PROFILER_COMPLETE, result),
	);
	performanceProfilerService.on("implementation-complete", (result) =>
		send(IPC_CHANNELS.PERFORMANCE_PROFILER_IMPLEMENTATION_COMPLETE, result),
	);
}
