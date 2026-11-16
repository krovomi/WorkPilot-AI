/**
 * Browser Agent recorder IPC handlers (#387).
 *
 * Channels:
 *   invoke "browserAgent:recordStart"  → (projectPath, url): open the page in a window and record
 *   invoke "browserAgent:recordStop"   → (): stop the running recording
 *   invoke "browserAgent:recordExport" → (projectPath, request): steps → test, see recorder-export.ts
 *
 * Renderer event:
 *   "browserAgent:recordEvent" (a step, started, stopped, an error)
 *
 * The project folder is checked before each handler (`DIRECTORY_ARGS`); the
 * address and the export request are read again here (S6): an http(s) URL,
 * formats and destinations from closed lists, step ids only.
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { readExportRequest } from "../../shared/types/browser-recorder";
import { exportRecording } from "../browser-recorder/recorder-export";
import { startRecording, stopRecording } from "../browser-recorder/recorder-session";

export function registerBrowserRecorderHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.BROWSER_AGENT_RECORD_START, (_event, projectPath: unknown, url: unknown) =>
		startRecording(projectPath, url),
	);

	ipcMain.handle(IPC_CHANNELS.BROWSER_AGENT_RECORD_STOP, () => stopRecording());

	ipcMain.handle(
		IPC_CHANNELS.BROWSER_AGENT_RECORD_EXPORT,
		async (_event, projectPath: unknown, raw: unknown) => {
			const request = readExportRequest(raw);
			if (typeof projectPath !== "string" || !projectPath || !request) {
				return { success: false, error: "Invalid export request" };
			}
			try {
				return await exportRecording(projectPath, request);
			} catch (error) {
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
}
