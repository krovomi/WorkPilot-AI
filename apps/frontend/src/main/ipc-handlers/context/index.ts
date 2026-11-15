import type { BrowserWindow } from "electron";
import { registerMemoryDataHandlers } from "./memory-data-handlers";
import { registerMemoryLifecycleHandlers } from "./memory-lifecycle-handlers";
import { registerMemoryStatusHandlers } from "./memory-status-handlers";
import { registerProjectContextHandlers } from "./project-context-handlers";

/**
 * Register all context-related IPC handlers
 */
export function registerContextHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	registerProjectContextHandlers(getMainWindow);
	registerMemoryStatusHandlers(getMainWindow);
	registerMemoryDataHandlers(getMainWindow);
	registerMemoryLifecycleHandlers();
}

export * from "./memory-data-handlers";
export * from "./memory-lifecycle-handlers";
export * from "./memory-status-handlers";
export * from "./project-context-handlers";
// Re-export utility functions for testing or external use
export * from "./utils";
