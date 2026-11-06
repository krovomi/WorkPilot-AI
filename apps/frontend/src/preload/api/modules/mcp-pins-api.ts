/**
 * MCP tool pins API module: the custom MCP servers' approved tools.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { McpPinsResult } from "../../../shared/types/mcp-pins";
import { invokeIpc } from "./ipc-utils";

export interface McpPinsAPI {
	getMcpPins: (projectDir: string) => Promise<McpPinsResult>;
	approveMcpServer: (
		projectDir: string,
		serverId: string,
		confirmSuspicious?: boolean,
	) => Promise<McpPinsResult>;
}

export function createMcpPinsAPI(): McpPinsAPI {
	return {
		getMcpPins: (projectDir: string) =>
			invokeIpc(IPC_CHANNELS.MCP_PINS_LIST, projectDir),
		approveMcpServer: (projectDir: string, serverId: string, confirmSuspicious = false) =>
			invokeIpc(IPC_CHANNELS.MCP_PINS_APPROVE, projectDir, serverId, confirmSuspicious),
	};
}
