/**
 * « Purger » of the Kanban: the worktrees whose work is over, their size, and
 * their removal on the person's say. The renderer names a project by id and
 * worktrees by spec id; each one is checked again here (S6).
 */
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { IPCResult } from "../../shared/types";
import type { PurgeCandidate, PurgeOutcome } from "../../shared/types/worktree-purge";
import { projectStore } from "../project-store";
import { startMergedWatch } from "./merged-watch";
import { listPurgeCandidates, purgeWorktrees } from "./purge";

const MAX_SPECS = 500;

function localProject(projectId: unknown) {
	if (typeof projectId !== "string" || !projectId) return null;
	const project = projectStore.getProject(projectId);
	return project?.path && !project.remote ? project : null;
}

export function registerWorktreePurgeHandlers(getMainWindow: () => BrowserWindow | null): void {
	ipcMain.handle(
		IPC_CHANNELS.WORKTREE_PURGE_LIST,
		async (_, projectId: unknown): Promise<IPCResult<PurgeCandidate[]>> => {
			const project = localProject(projectId);
			if (!project) return { success: false, error: "Project not found" };
			try {
				const tasks = projectStore.getTasks(project.id);
				return { success: true, data: await listPurgeCandidates(project, tasks) };
			} catch (error) {
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.WORKTREE_PURGE,
		async (_, projectId: unknown, specIds: unknown): Promise<IPCResult<PurgeOutcome[]>> => {
			const project = localProject(projectId);
			if (!project) return { success: false, error: "Project not found" };
			if (
				!Array.isArray(specIds) ||
				specIds.length > MAX_SPECS ||
				!specIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)
			) {
				return { success: false, error: "Invalid worktree list" };
			}
			try {
				const tasks = projectStore.getTasks(project.id);
				const outcomes = await purgeWorktrees(project, tasks, specIds as string[]);
				projectStore.invalidateTasksCache(project.id);
				return { success: true, data: outcomes };
			} catch (error) {
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);

	// A merged PR closes its card and frees its worktree without asking.
	startMergedWatch(getMainWindow);
}
