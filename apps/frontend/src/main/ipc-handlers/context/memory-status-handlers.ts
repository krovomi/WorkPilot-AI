import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { MemoryStatus, IPCResult } from "../../../shared/types";
import { featureProject } from "../server-feature-files";
import { fetchBrainMemoryStatus } from "./brain-memory";
import { fetchServerMemories } from "./server-context";

/**
 * Register memory status handlers.
 *
 * The status is the shared brain's: whether the vault exists, and where. It
 * used to be Graphiti's — a switch, an embedding provider, a LadybugDB path —
 * back when memory lived in whichever store that switch selected. A server
 * project's is its own brain's, on the server.
 */
export function registerMemoryStatusHandlers(
	_getMainWindow: () => BrowserWindow | null,
): void {
	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_MEMORY_STATUS,
		async (_, projectId: string): Promise<IPCResult<MemoryStatus>> => {
			const project = featureProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}
			if (project.remote) {
				const read = await fetchServerMemories(project, { limit: 1 });
				return read.success && read.data
					? { success: true, data: read.data.status }
					: { success: false, error: read.error ?? "Server unavailable" };
			}
			return { success: true, data: await fetchBrainMemoryStatus() };
		},
	);
}
