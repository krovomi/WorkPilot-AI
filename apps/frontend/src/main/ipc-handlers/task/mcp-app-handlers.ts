/**
 * MCP App views in the task panel.
 *
 * The renderer names a task and a view id, never a path: the spec
 * directories are the task's own (`allSpecDirs`), the view id is checked
 * against `VIEW_ID`, and the HTML never travels over IPC. The frame loads it
 * from `workpilot-mcp-app://<token>/` (mcp-apps/view-protocol.ts).
 *
 * Channels:
 *   invoke TASK_MCP_APPS_LIST (taskId)          → IPCResult<McpAppViewSummary[]>
 *   invoke TASK_MCP_APP_OPEN  (taskId, viewId)  → IPCResult<McpAppViewOpened>
 *   invoke TASK_MCP_APP_CLOSE (token)           → IPCResult
 *   send   TASK_MCP_APP_VIEW  (taskId, { viewId, server, tool })
 */

import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult } from "../../../shared/types";
import type { McpAppViewOpened, McpAppViewSummary } from "../../../shared/types/mcp-apps";
import { closeMcpAppView, openMcpAppView } from "../../mcp-apps/view-protocol";
import { listMcpAppViews, readMcpAppView, VIEW_ID } from "../../mcp-apps/view-store";
import { allSpecDirs, getSpecPaths } from "./resume-task";
import { findTaskAndProject } from "./shared";

/** The `MCP_APP_VIEW` task event's payload, as the backend emits it. */
const McpAppViewEventSchema = z.object({
	mcpApp: z.object({
		viewId: z.string().regex(VIEW_ID),
		server: z.string().min(1).max(200),
		tool: z.string().min(1).max(200),
	}),
});

export type McpAppViewEvent = z.infer<typeof McpAppViewEventSchema>["mcpApp"];

/** The view an `MCP_APP_VIEW` event announces, or null when it is malformed. */
export function parseMcpAppViewEvent(event: unknown): McpAppViewEvent | null {
	const parsed = McpAppViewEventSchema.safeParse(event);
	return parsed.success ? parsed.data.mcpApp : null;
}

function taskSpecDirs(taskId: unknown): { dirs: string[]; taskId: string } | null {
	if (typeof taskId !== "string" || !taskId) return null;
	const { task, project } = findTaskAndProject(taskId);
	if (!task || !project) return null;
	return { dirs: allSpecDirs(getSpecPaths(task, project)), taskId: task.id };
}

export function registerMcpAppHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.TASK_MCP_APPS_LIST,
		async (_, taskId: string): Promise<IPCResult<McpAppViewSummary[]>> => {
			const scope = taskSpecDirs(taskId);
			if (!scope) return { success: false, error: "Task not found" };
			return { success: true, data: listMcpAppViews(scope.dirs) };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.TASK_MCP_APP_OPEN,
		async (_, taskId: string, viewId: string): Promise<IPCResult<McpAppViewOpened>> => {
			const scope = taskSpecDirs(taskId);
			if (!scope) return { success: false, error: "Task not found" };
			const view = readMcpAppView(scope.dirs, viewId);
			if (!view) return { success: false, error: "View not found" };
			const { token, url } = openMcpAppView(scope.taskId, view);
			return {
				success: true,
				data: {
					viewId: view.viewId,
					server: view.server,
					tool: view.tool,
					createdAt: view.createdAt,
					url,
					token,
					toolInput: view.toolInput,
					toolResult: view.toolResult,
					prefersBorder: view.ui.prefersBorder === true,
				},
			};
		},
	);

	ipcMain.handle(IPC_CHANNELS.TASK_MCP_APP_CLOSE, async (_, token: string): Promise<IPCResult> => {
		closeMcpAppView(token);
		return { success: true };
	});
}
