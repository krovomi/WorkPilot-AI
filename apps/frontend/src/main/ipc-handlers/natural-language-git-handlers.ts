import { BrowserWindow, ipcMain } from "electron";
import type { NaturalLanguageGitRequest } from "../natural-language-git-service";
import { naturalLanguageGitService } from "../natural-language-git-service";
import { getPageFeatureSettings } from "../services/page-llm-config";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

/**
 * Set up IPC handlers for natural language Git functionality
 */
export function setupNaturalLanguageGitHandlers(): void {
	// Execute natural language Git command
	ipcMain.handle(
		IPC_CHANNELS.EXECUTE_NATURAL_LANGUAGE_GIT,
		async (event, request: NaturalLanguageGitRequest) => {
			try {
				// Le renderer peut ne rien imposer : la page décide, sinon les
				// réglages — une seule lecture, côté main.
				const page = getPageFeatureSettings("natural-language-git");
				await naturalLanguageGitService.execute({
					...request,
					model: request.model || page.model,
					thinkingLevel: request.thinkingLevel || page.thinkingLevel,
				});
			} catch (error) {
				console.error("[NaturalLanguageGit] Error executing command:", error);
				const win = BrowserWindow.fromWebContents(event.sender);
				if (win) {
					win.webContents.send(
						IPC_CHANNELS.NATURAL_LANGUAGE_GIT_ERROR,
						error instanceof Error ? error.message : "Unknown error",
					);
				}
			}
		},
	);

	// Cancel natural language Git command
	ipcMain.handle(IPC_CHANNELS.CANCEL_NATURAL_LANGUAGE_GIT, () => {
		return naturalLanguageGitService.cancel();
	});

	// Forward service events to renderer
	naturalLanguageGitService.on("status", (status: string) => {
		const windows = BrowserWindow.getAllWindows();
		windows.forEach((win) => {
			win.webContents.send(IPC_CHANNELS.NATURAL_LANGUAGE_GIT_STATUS, status);
		});
	});

	naturalLanguageGitService.on("stream-chunk", (chunk: string) => {
		const windows = BrowserWindow.getAllWindows();
		windows.forEach((win) => {
			win.webContents.send(IPC_CHANNELS.NATURAL_LANGUAGE_GIT_STREAM_CHUNK, chunk);
		});
	});

	naturalLanguageGitService.on("error", (error: string) => {
		const windows = BrowserWindow.getAllWindows();
		windows.forEach((win) => {
			win.webContents.send(IPC_CHANNELS.NATURAL_LANGUAGE_GIT_ERROR, error);
		});
	});

	naturalLanguageGitService.on("complete", (result) => {
		const windows = BrowserWindow.getAllWindows();
		windows.forEach((win) => {
			win.webContents.send(IPC_CHANNELS.NATURAL_LANGUAGE_GIT_COMPLETE, result);
		});
	});
}
