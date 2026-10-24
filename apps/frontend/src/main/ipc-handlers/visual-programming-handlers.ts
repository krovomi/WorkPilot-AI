import { ipcMain } from "electron";
import {
	type GeneratedFile,
	type VisualProgrammingRequest,
	visualProgrammingService,
} from "../visual-programming-service";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

export function registerVisualProgrammingHandlers(
	_getMainWindow: () => import("electron").BrowserWindow | null,
): void {
	ipcMain.handle(
		IPC_CHANNELS.VISUAL_PROGRAMMING_RUN,
		async (_event, request: VisualProgrammingRequest) => {
			try {
				await visualProgrammingService.run(request);
				return { success: true };
			} catch (error) {
				console.error("[VisualProg] Run error:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	ipcMain.handle(IPC_CHANNELS.VISUAL_PROGRAMMING_CANCEL, async () => {
		try {
			const cancelled = visualProgrammingService.cancel();
			return { success: true, cancelled };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});
}

export function setupVisualProgrammingEventForwarding(
	getMainWindow: () => import("electron").BrowserWindow | null,
): void {
	visualProgrammingService.on("status", (msg: string) => {
		const win = getMainWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(IPC_CHANNELS.VISUAL_PROGRAMMING_STATUS, msg);
		}
	});

	visualProgrammingService.on("file", (file: GeneratedFile) => {
		const win = getMainWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(IPC_CHANNELS.VISUAL_PROGRAMMING_FILE, file);
		}
	});

	visualProgrammingService.on("writing", (filename: string) => {
		const win = getMainWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(IPC_CHANNELS.VISUAL_PROGRAMMING_WRITING, filename);
		}
	});

	visualProgrammingService.on("error", (err: string) => {
		const win = getMainWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(IPC_CHANNELS.VISUAL_PROGRAMMING_ERROR, err);
		}
	});

	visualProgrammingService.on("complete", (result: unknown) => {
		const win = getMainWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(IPC_CHANNELS.VISUAL_PROGRAMMING_COMPLETE, result);
		}
	});
}
