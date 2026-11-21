/**
 * "How you compare" in Build Analytics, for a project of this computer
 * (`../build-compare.ts`). The folder is checked before the handler
 * (`DIRECTORY_ARGS`) and against the registered projects by
 * `compareLocalProject`; a server project is compared by the server
 * (`server-workspace-handlers.ts`).
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { compareLocalProject } from "../build-compare";

export function registerBuildCompareHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.DASHBOARD_COMPARE, (_event, projectPath: unknown) =>
		compareLocalProject(projectPath),
	);
}
