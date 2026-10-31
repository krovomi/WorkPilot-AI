/**
 * Server mode: register a repository on the server as a project of the team,
 * or delete one. The renderer passes a name, a repository URL and a branch, or
 * a project id the app listed; never a path. The server decides who may.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { createServerProject, deleteServerProject } from "../server-projects";

export function registerServerProjectHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.SERVER_PROJECT_CREATE, async (_e, input: unknown) =>
		createServerProject(input),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_PROJECT_DELETE, async (_e, projectId: unknown) =>
		deleteServerProject(projectId),
	);
}
