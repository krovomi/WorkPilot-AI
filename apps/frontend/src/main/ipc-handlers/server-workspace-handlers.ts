/**
 * Server mode: the dashboard, analytics, costs and session history of a
 * server project, read from the server (`../server-workspace.ts`). The
 * renderer passes the id of a server project the app listed, never a path;
 * any other id is refused before anything is asked.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { IPCResult, Project } from "../../shared/types";
import { getServerProject } from "../server-projects";
import {
	fetchServerCostSummary,
	fetchServerDashboard,
	fetchServerSessions,
} from "../server-workspace";

const NOT_A_SERVER_PROJECT = "Not a project of the server";

function onServerProject<T>(
	read: (project: Project) => Promise<IPCResult<T>>,
): (_event: unknown, projectId: unknown) => Promise<IPCResult<T>> {
	return async (_event, projectId) => {
		const project = getServerProject(projectId);
		if (!project) return { success: false, error: NOT_A_SERVER_PROJECT };
		return read(project);
	};
}

export function registerServerWorkspaceHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.SERVER_WORKSPACE_COSTS,
		onServerProject(fetchServerCostSummary),
	);
	ipcMain.handle(
		IPC_CHANNELS.SERVER_WORKSPACE_DASHBOARD,
		onServerProject(fetchServerDashboard),
	);
	ipcMain.handle(
		IPC_CHANNELS.SERVER_WORKSPACE_SESSIONS,
		onServerProject(fetchServerSessions),
	);
}
