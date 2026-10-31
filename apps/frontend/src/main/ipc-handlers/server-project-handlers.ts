/**
 * Server mode: register a repository on the server as a project of the team,
 * or delete one, and follow a shown server board live. The renderer passes a
 * name, a repository URL and a branch, or a project id the app listed; never
 * a path. The server decides who may.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { unwatchServerBoard, watchServerBoard } from "../server-board-live";
import { createServerProject, deleteServerProject } from "../server-projects";

export function registerServerProjectHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.SERVER_PROJECT_CREATE, async (_e, input: unknown) =>
		createServerProject(input),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_PROJECT_DELETE, async (_e, projectId: unknown) =>
		deleteServerProject(projectId),
	);
	// The updates go back to the window that asked, and stop when it closes.
	ipcMain.handle(IPC_CHANNELS.SERVER_BOARD_WATCH, (event, projectId: unknown) => {
		const sender = event.sender;
		const watching = watchServerBoard(projectId, (update) => {
			if (sender.isDestroyed()) unwatchServerBoard(update.projectId);
			else sender.send(IPC_CHANNELS.SERVER_BOARD_LIVE, update);
		});
		if (watching) sender.once("destroyed", () => unwatchServerBoard(projectId));
		return { success: watching };
	});
	ipcMain.handle(IPC_CHANNELS.SERVER_BOARD_UNWATCH, (_e, projectId: unknown) => {
		unwatchServerBoard(projectId);
		return { success: true };
	});
}
