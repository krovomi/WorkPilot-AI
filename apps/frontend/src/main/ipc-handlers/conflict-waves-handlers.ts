/**
 * Execution waves across specs (Conflict Predictor, #358). One channel: the
 * renderer sends a project id, optional task ids and bounded options; every
 * argument is revalidated in `buildExecutionWavePlan`, the project and its
 * tasks are resolved here, and the worktrees are read with git by argument
 * list. Nothing is started from here: the renderer starts a wave through the
 * ordinary task status path, whatever the provider of each task.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult } from "../../shared/types";
import type { ExecutionWavePlan } from "../../shared/types/conflict-waves";
import { buildExecutionWavePlan, type WavePlanDeps } from "../conflict-waves/plan-service";
import { readWorktreeChangedFiles } from "../conflict-waves/worktree-files";
import { projectStore } from "../project-store";

const defaultDeps: WavePlanDeps = {
	getProject: (projectId) => projectStore.getProject(projectId),
	getTasks: (projectId) => projectStore.getTasks(projectId),
	readWorktreeFiles: readWorktreeChangedFiles,
};

export function registerConflictWavesHandlers(deps: WavePlanDeps = defaultDeps): void {
	ipcMain.handle(
		IPC_CHANNELS.CONFLICT_WAVES_PLAN,
		async (_event, request: unknown): Promise<IPCResult<ExecutionWavePlan>> => {
			try {
				const result = await buildExecutionWavePlan(request, deps);
				return result.ok
					? { success: true, data: result.value }
					: { success: false, error: result.error };
			} catch (error) {
				console.error("[conflictWaves:plan] planning failed:", error);
				return { success: false, error: "Planning failed" };
			}
		},
	);
}
