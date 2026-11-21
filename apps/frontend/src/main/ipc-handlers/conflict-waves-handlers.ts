/**
 * Execution waves across specs (Conflict Predictor, #358). One channel: the
 * renderer sends a project id, optional task ids and bounded options; every
 * argument is revalidated in `buildExecutionWavePlan`, the project and its
 * tasks are resolved here, and the worktrees are read with git by argument
 * list. Nothing is started from here: the renderer starts a wave through the
 * ordinary task status path, whatever the provider of each task.
 *
 * The run itself is saved in the project (`run-store.ts`) by project id: the
 * renderer never names a path, and the state it sends is revalidated here.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult } from "../../shared/types";
import type { ExecutionWavePlan, SavedWaveRunResult } from "../../shared/types/conflict-waves";
import type { Project } from "../../shared/types/project";
import { readCoChanges } from "../conflict-waves/fragile-zones";
import { gitTestMerge, readWorktreeHead } from "../conflict-waves/merge-check";
import { buildExecutionWavePlan, PROJECT_ID, type WavePlanDeps } from "../conflict-waves/plan-service";
import {
	clearSavedRun,
	readSavedRun,
	validateRunState,
	writeSavedRun,
} from "../conflict-waves/run-store";
import { readWorktreeChangedFiles } from "../conflict-waves/worktree-files";
import { projectStore } from "../project-store";

const defaultDeps: WavePlanDeps = {
	getProject: (projectId) => projectStore.getProject(projectId),
	getTasks: (projectId) => projectStore.getTasks(projectId),
	readWorktreeFiles: readWorktreeChangedFiles,
	worktreeHead: readWorktreeHead,
	testMerge: gitTestMerge,
	readCoChanges,
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

	/** A registered project named by a well-formed id, or null. */
	const projectOf = (projectId: unknown): Project | null => {
		if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) return null;
		return deps.getProject(projectId) ?? null;
	};

	ipcMain.handle(
		IPC_CHANNELS.CONFLICT_WAVES_RUN_LOAD,
		async (_event, projectId: unknown): Promise<IPCResult<SavedWaveRunResult>> => {
			const project = projectOf(projectId);
			if (!project) return { success: false, error: "Project not found" };
			try {
				const known = new Set(deps.getTasks(project.id).map((t) => t.id));
				return { success: true, data: readSavedRun(project.path, project.id, known) };
			} catch (error) {
				console.error("[conflictWaves:loadRun] reading the saved run failed:", error);
				return { success: true, data: { run: null, ignored: true } };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CONFLICT_WAVES_RUN_SAVE,
		async (_event, state: unknown): Promise<IPCResult<void>> => {
			const project = projectOf((state as { projectId?: unknown } | null)?.projectId);
			if (!project) return { success: false, error: "Project not found" };
			const valid = validateRunState(state, project.id);
			if (!valid) return { success: false, error: "Invalid run state" };
			try {
				writeSavedRun(project.path, valid, deps.now?.() ?? new Date());
				return { success: true };
			} catch (error) {
				console.error("[conflictWaves:saveRun] saving the run failed:", error);
				return { success: false, error: "Could not save the run" };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CONFLICT_WAVES_RUN_CLEAR,
		async (_event, projectId: unknown): Promise<IPCResult<void>> => {
			const project = projectOf(projectId);
			if (!project) return { success: false, error: "Project not found" };
			try {
				clearSavedRun(project.path);
				return { success: true };
			} catch (error) {
				console.error("[conflictWaves:clearRun] clearing the run failed:", error);
				return { success: false, error: "Could not clear the run" };
			}
		},
	);
}
