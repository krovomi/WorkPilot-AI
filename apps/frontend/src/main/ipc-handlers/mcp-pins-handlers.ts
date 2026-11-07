/**
 * MCP tool pins IPC handlers: list a project's pinned custom MCP servers and
 * approve one (`apps/backend/mcp_pins/api.py`). The project directory is
 * argument 0, checked by the path policy (`security/ipc-path-policy.ts`).
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { McpPinnedServer, McpPinsResult } from "../../shared/types/mcp-pins";
import { type BackendError, backendFetch } from "./_backend-fetch";

/** A server id as `CUSTOM_MCP_SERVERS` writes it; the backend caps it at 200. */
const SERVER_ID = /^[\w.-]{1,200}$/;

interface PinsResponse {
	servers?: McpPinnedServer[];
	suspicious?: boolean;
}

export function registerMcpPinsHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.MCP_PINS_LIST,
		async (_event, projectDir: string): Promise<McpPinsResult> => {
			const query = new URLSearchParams({ project_dir: projectDir });
			const result = await backendFetch<PinsResponse>(
				`/api/mcp-pins?${query.toString()}`,
				{ method: "GET" },
				15_000,
			);
			return result.success
				? { success: true, data: result.servers ?? [] }
				: { success: false, error: result.error };
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.MCP_PINS_APPROVE,
		async (
			_event,
			projectDir: string,
			serverId: unknown,
			confirmSuspicious: unknown,
		): Promise<McpPinsResult> => {
			if (typeof serverId !== "string" || !SERVER_ID.test(serverId)) {
				return { success: false, error: "Invalid server" };
			}
			// No headers: backendFetch sets the JSON content type and the
			// server-mode Authorization header.
			const result = await backendFetch<PinsResponse>("/api/mcp-pins/approve", {
				method: "POST",
				body: JSON.stringify({
					project_dir: projectDir,
					server_id: serverId,
					confirm_suspicious: confirmSuspicious === true,
				}),
			});
			return result.success
				? { success: true, data: result.servers ?? [] }
				: {
						success: false,
						error: result.error,
						// The backend's refusal body comes through as it is.
						suspicious: (result as BackendError & PinsResponse).suspicious === true,
					};
		},
	);
}
