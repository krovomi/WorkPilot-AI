/**
 * Task handlers module
 *
 * This module organizes all task-related IPC handlers into logical groups:
 * - CRUD operations (create, read, update, delete)
 * - Execution management (start, stop, review, status, recovery)
 * - Worktree operations (status, diff, merge, discard, list)
 * - Logs management (get, watch, unwatch)
 */

import type { BrowserWindow } from "electron";
import type { AgentManager } from "../../agent";
import type { PythonEnvManager } from "../../python-env-manager";
import { registerTaskArchiveHandlers } from "./archive-handlers";
import { registerTaskContextHandlers } from "./context-handlers";
import { registerTaskCRUDHandlers } from "./crud-handlers";
import { registerTaskExecutionHandlers } from "./execution-handlers";
import { registerGoalHandlers } from "./goal-handlers";
import { registerTaskLogsHandlers } from "./logs-handlers";
import { registerMcpAppHandlers } from "./mcp-app-handlers";
import { registerPrFollowupHandlers } from "./pr-followup-handlers";
import { registerWorktreeHandlers } from "./worktree-handlers";

/**
 * Register all task-related IPC handlers
 */
export function registerTaskHandlers(
	agentManager: AgentManager,
	pythonEnvManager: PythonEnvManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	// Register CRUD handlers (create, read, update, delete)
	registerTaskCRUDHandlers(agentManager);

	// Register execution handlers (start, stop, review, status management, recovery)
	registerTaskExecutionHandlers(agentManager, getMainWindow);

	// Register context-window handlers (manual compact/clear, live policy edit)
	registerTaskContextHandlers(agentManager);

	// Register goal handlers (goal mode: the command that says "done")
	registerGoalHandlers();

	// Register worktree handlers (status, diff, merge, discard, list)
	registerWorktreeHandlers(pythonEnvManager, getMainWindow);

	// Register logs handlers (get, watch, unwatch)
	registerTaskLogsHandlers(getMainWindow);

	// Register archive handlers (archive, unarchive)
	registerTaskArchiveHandlers();

	// Register PR follow-through handlers (drive the task's PR to merge)
	registerPrFollowupHandlers(getMainWindow);

	// Register MCP App view handlers (list, open, close)
	registerMcpAppHandlers();
}

// Export shared utilities for use by other modules if needed
export { findTaskAndProject } from "./shared";
