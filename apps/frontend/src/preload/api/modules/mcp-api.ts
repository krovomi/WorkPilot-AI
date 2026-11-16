/**
 * MCP Server API
 *
 * Exposes MCP health check and connection test functionality to the renderer.
 */

import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { IPCResult } from "../../../shared/types/common";
import type {
	HuggingFaceModelInfo,
	HuggingFaceModelSearchParams,
} from "../../../shared/types/mcp-marketplace";
import type {
	McpSecurityRequest,
	McpSecurityScore,
} from "../../../shared/types/mcp-security";
import type {
	CustomMcpServer,
	McpHealthCheckResult,
	McpTestConnectionResult,
} from "../../../shared/types/project";

export interface McpAPI {
	/**
	 * Quick health check for a custom MCP server. With `projectId`, a masked
	 * header or environment value is the one stored for that server.
	 */
	checkMcpHealth: (
		server: CustomMcpServer,
		projectId?: string,
	) => Promise<IPCResult<McpHealthCheckResult>>;
	/** Full MCP connection test (`projectId` as for `checkMcpHealth`) */
	testMcpConnection: (
		server: CustomMcpServer,
		projectId?: string,
	) => Promise<IPCResult<McpTestConnectionResult>>;
	/** Live Hugging Face Hub model search (via the official HF MCP server) */
	searchHuggingFaceModels: (
		params: HuggingFaceModelSearchParams,
	) => Promise<IPCResult<HuggingFaceModelInfo[]>>;
	/** Security score of a catalog server: catalog, registry and OSV facts */
	getMcpServerSecurity: (
		request: McpSecurityRequest,
	) => Promise<IPCResult<McpSecurityScore>>;
}

export function createMcpAPI(): McpAPI {
	return {
		checkMcpHealth: (server: CustomMcpServer, projectId?: string) =>
			ipcRenderer.invoke(IPC_CHANNELS.MCP_CHECK_HEALTH, server, projectId),

		testMcpConnection: (server: CustomMcpServer, projectId?: string) =>
			ipcRenderer.invoke(IPC_CHANNELS.MCP_TEST_CONNECTION, server, projectId),

		searchHuggingFaceModels: (params: HuggingFaceModelSearchParams) =>
			ipcRenderer.invoke(IPC_CHANNELS.HUGGINGFACE_SEARCH_MODELS, params),

		getMcpServerSecurity: (request: McpSecurityRequest) =>
			ipcRenderer.invoke(IPC_CHANNELS.MCP_MARKETPLACE_GET_SECURITY, request),
	};
}
