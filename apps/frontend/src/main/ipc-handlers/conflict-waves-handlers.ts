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
 * When a run ends, the renderer says how (a closed list) and the record of
 * the run history (`run-history.ts`) is built here from the saved run.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult } from "../../shared/types";
import type {
	ExecutionWavePlan,
	SavedWaveRunResult,
	WaveRunHistory,
} from "../../shared/types/conflict-waves";
import type { Project } from "../../shared/types/project";
import { readSpecCode } from "../conflict-waves/code-reader";
import { readCoChanges } from "../conflict-waves/fragile-zones";
import { gitTestMerge, readWorktreeHead } from "../conflict-waves/merge-check";
import { buildExecutionWavePlan, PROJECT_ID, type WavePlanDeps } from "../conflict-waves/plan-service";
import {
	appendRunRecord,
	isRunOutcome,
	readRunHistory,
	recordOf,
} from "../conflict-waves/run-history";
import {
	clearSavedRun,
	readSavedRun,
	validateRunState,
	writeSavedRun,
} from "../conflict-waves/run-store";
import { readWorktreeChangedFiles, readWorktreeDiff } from "../conflict-waves/worktree-files";
import { projectStore } from "../project-store";

const defaultDeps: WavePlanDeps = {
	getProject: (projectId) => projectStore.getProject(projectId),
	getTasks: (projectId) => projectStore.getTasks(projectId),
	readWorktreeFiles: readWorktreeChangedFiles,
	worktreeHead: readWorktreeHead,
	testMerge: gitTestMerge,
	readCoChanges,
	readCodeSource: readWorktreeDiff,
	readSpecCode,
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
		async (_event, projectId: unknown, outcome?: unknown): Promise<IPCResult<void>> => {
			const project = projectOf(projectId);
			if (!project) return { success: false, error: "Project not found" };
			if (outcome !== undefined && !isRunOutcome(outcome)) {
				return { success: false, error: "Invalid outcome" };
			}
			if (outcome !== undefined) {
				// The record comes from the run saved here, never from the renderer.
				try {
					const known = new Set(deps.getTasks(project.id).map((t) => t.id));
					const { run } = readSavedRun(project.path, project.id, known);
					if (run) appendRunRecord(project.path, recordOf(run, outcome, deps.now?.() ?? new Date()));
				} catch (error) {
					console.error("[conflictWaves:clearRun] recording the run failed:", error);
				}
			}
			try {
				clearSavedRun(project.path);
				return { success: true };
			} catch (error) {
				console.error("[conflictWaves:clearRun] clearing the run failed:", error);
				return { success: false, error: "Could not clear the run" };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CONFLICT_WAVES_HISTORY,
		async (_event, projectId: unknown): Promise<IPCResult<WaveRunHistory>> => {
			const project = projectOf(projectId);
			if (!project) return { success: false, error: "Project not found" };
			try {
				return { success: true, data: readRunHistory(project.path) };
			} catch (error) {
				console.error("[conflictWaves:history] reading the history failed:", error);
				return { success: true, data: { records: [], ignored: true } };
			}
		},
	);
}
