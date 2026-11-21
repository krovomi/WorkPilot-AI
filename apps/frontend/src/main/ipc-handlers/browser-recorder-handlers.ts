/**
 * Browser Agent recorder IPC handlers (#387).
 *
 * Channels:
 *   invoke "browserAgent:recordStart"  → (projectPath, url): open the page in a window and record
 *   invoke "browserAgent:recordStop"   → (): stop the running recording
 *   invoke "browserAgent:recordDialog" → ({id, accept, text}): answer the dialog the page opened
 *   invoke "browserAgent:recordExport" → (projectPath, request): steps → test, see recorder-export.ts
 *   invoke "browserAgent:recordRun"     → (projectPath): run the test proposed on a review card, see recorder-run.ts
 *   invoke "browserAgent:recordReshoot" → (projectPath): replay the stopped recording without a window
 *   invoke "browserAgent:recordReshootApply" → (projectPath, stepIds): take the selectors it proposed
 *   invoke "browserAgent:recordAssist"  → (projectPath): a name and the checks ranked, see recorder-assist.ts
 *
 * Renderer event:
 *   "browserAgent:recordEvent" (a step, started, stopped, an error)
 *
 * The project folder is checked before each handler (`DIRECTORY_ARGS`); the
 * address, the dialog answer and the export request are read again (S6): an
 * http(s) URL, the id of the dialog waiting, formats and destinations from
 * closed lists, step ids only.
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { readExportRequest } from "../../shared/types/browser-recorder";
import { readStepIds } from "../../shared/types/browser-recorder-run";
import { exportRecording } from "../browser-recorder/recorder-export";
import { assistRecording } from "../browser-recorder/recorder-assist";
import { applyReshoot, defaultRunDeps, reshootRecording, runRecordedTest } from "../browser-recorder/recorder-run";
import { answerDialog, startRecording, stopRecording } from "../browser-recorder/recorder-session";

export function registerBrowserRecorderHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.BROWSER_AGENT_RECORD_START, (_event, projectPath: unknown, url: unknown) =>
		startRecording(projectPath, url),
	);

	ipcMain.handle(IPC_CHANNELS.BROWSER_AGENT_RECORD_STOP, () => stopRecording());

	ipcMain.handle(IPC_CHANNELS.BROWSER_AGENT_RECORD_DIALOG, (_event, answer: unknown) => answerDialog(answer));

	ipcMain.handle(IPC_CHANNELS.BROWSER_AGENT_RECORD_RUN, (_event, projectPath: unknown) =>
		typeof projectPath === "string" && projectPath
			? runRecordedTest(projectPath, defaultRunDeps)
			: { success: false, error: "No project" },
	);

	ipcMain.handle(IPC_CHANNELS.BROWSER_AGENT_RECORD_ASSIST, (_event, projectPath: unknown) =>
		typeof projectPath === "string" && projectPath
			? assistRecording(projectPath)
			: { success: false, error: "No project" },
	);

	ipcMain.handle(IPC_CHANNELS.BROWSER_AGENT_RECORD_RESHOOT, (_event, projectPath: unknown) =>
		typeof projectPath === "string" && projectPath
			? reshootRecording(projectPath, defaultRunDeps)
			: { success: false, error: "No project" },
	);

	ipcMain.handle(
		IPC_CHANNELS.BROWSER_AGENT_RECORD_RESHOOT_APPLY,
		(_event, projectPath: unknown, stepIds: unknown) => {
			const ids = readStepIds(stepIds);
			if (typeof projectPath !== "string" || !projectPath || !ids) return { success: false, applied: 0 };
			return applyReshoot(projectPath, ids, defaultRunDeps);
		},
	);

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
