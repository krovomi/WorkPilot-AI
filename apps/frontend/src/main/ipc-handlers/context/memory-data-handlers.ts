import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	ContextSearchResult,
	IPCResult,
	MemoryEpisode,
} from "../../../shared/types";
import { featureProject } from "../server-feature-files";
import { loadBrainMemories, searchBrainMemories } from "./brain-memory";
import { fetchServerMemories } from "./server-context";

/**
 * Register memory data handlers.
 *
 * Both answers come from the shared brain (`brain-memory.ts`): the one store
 * of what the builds learned. A server project's are its own brain's, on the
 * server (`server-context.ts`).
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
			const project = featureProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}
			if (project.remote) {
				const read = await fetchServerMemories(project, { limit });
				return read.success && read.data
					? { success: true, data: read.data.memories }
					: { success: false, error: read.error ?? "Server unavailable" };
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
			const project = featureProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}
			if (project.remote) {
				const read = await fetchServerMemories(project, { query, limit: 20 });
				return read.success && read.data
					? { success: true, data: read.data.results }
					: { success: false, error: read.error ?? "Server unavailable" };
			}
			return {
				success: true,
				data: await searchBrainMemories(project.path, query, 20),
			};
		},
	);
}
