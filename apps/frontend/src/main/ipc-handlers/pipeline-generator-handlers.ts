import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import {
	type PipelineGeneratorRequest,
	type PipelineGeneratorResult,
	pipelineGeneratorService,
} from "../pipeline-generator-service";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

export function registerPipelineGeneratorHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.PIPELINE_GENERATOR_GENERATE,
		async (_event, request: PipelineGeneratorRequest) => {
			try {
				await pipelineGeneratorService.generate(request);
				return { success: true };
			} catch (error) {
				console.error("[PipelineGenerator] Generate error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	ipcMain.handle(IPC_CHANNELS.PIPELINE_GENERATOR_CANCEL, async () => {
		try {
			const cancelled = pipelineGeneratorService.cancel();
			return { success: true, cancelled };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});
}

export function setupPipelineGeneratorEventForwarding(
	getMainWindow: () => BrowserWindow | null,
): void {
	pipelineGeneratorService.on("status", (status: string) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(IPC_CHANNELS.PIPELINE_GENERATOR_STATUS, status);
		}
	});

	pipelineGeneratorService.on("stream-chunk", (chunk: string) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(IPC_CHANNELS.PIPELINE_GENERATOR_STREAM_CHUNK, chunk);
		}
	});

	pipelineGeneratorService.on("error", (error: string) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(IPC_CHANNELS.PIPELINE_GENERATOR_ERROR, error);
		}
	});

	pipelineGeneratorService.on("complete", (result: PipelineGeneratorResult) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(IPC_CHANNELS.PIPELINE_GENERATOR_COMPLETE, result);
		}
	});
}
