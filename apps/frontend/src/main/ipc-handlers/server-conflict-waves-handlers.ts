/**
 * Execution waves of a server project (Conflict Predictor, #358), in server
 * mode. The renderer names a listed server project by id, and the advance
 * rule from a closed list; nothing else crosses. The server plans and runs
 * the waves (`../conflict-waves/server-waves.ts`) and checks the person's
 * rights again on every route.
 *
 *   conflictWaves:serverPlan    → projectId → IPCResult<ServerWavePlan>
 *   conflictWaves:serverRun     → projectId → IPCResult<ServerWaveRunAnswer>
 *   conflictWaves:serverStart   → projectId, advanceWhen → IPCResult<ServerWaveRunAnswer>
 *   conflictWaves:serverStep    → projectId → IPCResult<ServerWaveRunAnswer>
 *   conflictWaves:serverStop    → projectId → IPCResult<ServerWaveRunAnswer>
 *   conflictWaves:serverHistory → projectId → IPCResult<ServerWaveHistory>
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { IPCResult, Project } from "../../shared/types";
import {
	fetchServerWaveHistory,
	fetchServerWavePlan,
	fetchServerWaveRun,
	startServerWaveRun,
	stepServerWaveRun,
	stopServerWaveRun,
} from "../conflict-waves/server-waves";
import { getServerProject } from "../server-projects";

const NOT_A_SERVER_PROJECT = "Not a project of the server";

function onServerProject<T>(
	act: (project: Project, extra: unknown) => Promise<IPCResult<T>>,
): (_event: unknown, projectId: unknown, extra?: unknown) => Promise<IPCResult<T>> {
	return async (_event, projectId, extra) => {
		const project = getServerProject(projectId);
		if (!project?.remote) return { success: false, error: NOT_A_SERVER_PROJECT };
		return act(project, extra);
	};
}

export function registerServerConflictWavesHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.CONFLICT_WAVES_SERVER_PLAN,
		onServerProject((project) => fetchServerWavePlan(project)),
	);
	ipcMain.handle(
		IPC_CHANNELS.CONFLICT_WAVES_SERVER_RUN,
		onServerProject((project) => fetchServerWaveRun(project)),
	);
	ipcMain.handle(
		IPC_CHANNELS.CONFLICT_WAVES_SERVER_START,
		onServerProject((project, advanceWhen) => startServerWaveRun(project, advanceWhen)),
	);
	ipcMain.handle(
		IPC_CHANNELS.CONFLICT_WAVES_SERVER_STEP,
		onServerProject((project) => stepServerWaveRun(project)),
	);
	ipcMain.handle(
		IPC_CHANNELS.CONFLICT_WAVES_SERVER_STOP,
		onServerProject((project) => stopServerWaveRun(project)),
	);
	ipcMain.handle(
		IPC_CHANNELS.CONFLICT_WAVES_SERVER_HISTORY,
		onServerProject((project) => fetchServerWaveHistory(project)),
	);
}
