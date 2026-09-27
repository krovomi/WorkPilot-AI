import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { GraphitiMemoryStatus, IPCResult } from "../../../shared/types";
import { projectStore } from "../../project-store";
import { fetchBrainMemoryStatus } from "./brain-memory";

/**
 * Register memory status handlers.
 *
 * The status is the shared brain's: whether the vault exists, and where. It
 * used to be Graphiti's — a switch, an embedding provider, a LadybugDB path —
 * back when memory lived in whichever store that switch selected.
 */
export function registerMemoryStatusHandlers(
	_getMainWindow: () => BrowserWindow | null,
): void {
	ipcMain.handle(
		IPC_CHANNELS.CONTEXT_MEMORY_STATUS,
		async (_, projectId: string): Promise<IPCResult<GraphitiMemoryStatus>> => {
			const project = projectStore.getProject(projectId);
			if (!project) {
				return { success: false, error: "Project not found" };
			}
			return { success: true, data: await fetchBrainMemoryStatus() };
		},
	);
}
