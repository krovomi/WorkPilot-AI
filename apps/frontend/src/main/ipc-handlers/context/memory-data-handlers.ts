import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	ContextSearchResult,
	IPCResult,
	MemoryEpisode,
} from "../../../shared/types";
import { projectStore } from "../../project-store";
import { loadBrainMemories, searchBrainMemories } from "./brain-memory";

/**
 * Register memory data handlers.
 *
 * Both answers come from the shared brain (`brain-memory.ts`): the one store
 * of what the builds learned.
 */
export function registerMemoryDataHandlers(
	_getMainWindow: () => BrowserWindow | null,
): void {
	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_GET_MEMORIES,
		async (
			_,
			projectId: string,
			limit: number = 20,
		): Promise<IPCResult<MemoryEpisode[]>> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}
			return { success: true, data: await loadBrainMemories(project.path, limit) };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_SEARCH_MEMORIES,
		async (
			_,
			projectId: string,
			query: string,
		): Promise<IPCResult<ContextSearchResult[]>> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}
			return {
				success: true,
				data: await searchBrainMemories(project.path, query, 20),
			};
		},
	);
}
