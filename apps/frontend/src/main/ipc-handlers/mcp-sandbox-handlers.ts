/**
 * Whether this machine starts an MCP server that must run confined (#369,
 * lot 6): one channel of the marketplace, read by its installed list, its
 * policy banner and Agent Tools. `main/mcp-security/sandbox-status.ts` asks
 * the backend; the renderer only chooses whether to ask again.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { IPCResult } from "../../shared/types/common";
import type { McpSandboxStatus } from "../../shared/types/mcp-sandbox";
import { mcpSandboxStatus, parseSandboxRequest } from "../mcp-security/sandbox-status";

export async function getMcpSandbox(request: unknown): Promise<IPCResult<McpSandboxStatus>> {
	const parsed = parseSandboxRequest(request);
	if (!parsed) return { success: false, error: "Invalid request" };
	return { success: true, data: await mcpSandboxStatus(parsed.refresh) };
}

export function registerMcpSandboxHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.MCP_MARKETPLACE_GET_SANDBOX, (_event, request: unknown) =>
		getMcpSandbox(request),
	);
}
