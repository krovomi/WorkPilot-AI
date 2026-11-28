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
import type { McpPolicyState } from "../../../shared/types/mcp-policy";
import type {
	McpReviewDeleteRequest,
	McpReviewList,
	McpReviewListRequest,
	McpReviewRequest,
	McpServerReview,
} from "../../../shared/types/mcp-reviews";
import type { McpSandboxRequest, McpSandboxStatus } from "../../../shared/types/mcp-sandbox";
import type {
	McpInstalledWatchView,
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
	/** The project's MCP install policy (`.workpilot/mcp-policy.json`), read by the main */
	getMcpInstallPolicy: (request: {
		projectId: string;
	}) => Promise<IPCResult<McpPolicyState>>;
	/** What the daily check found on the project's installed servers */
	getMcpInstalledWatch: (request: {
		projectId: string;
	}) => Promise<IPCResult<McpInstalledWatchView>>;
	/** Acknowledges every alert of a catalog server; false when it had none */
	acknowledgeMcpAlerts: (request: { serverId: string }) => Promise<IPCResult<boolean>>;
	/**
	 * The organization's reviews of a catalog server, from a server project,
	 * the latest first, and whether the caller may write one
	 */
	listMcpReviews: (request: McpReviewListRequest) => Promise<IPCResult<McpReviewList>>;
	/** Writes the caller's review of a catalog server, replacing the one they left */
	putMcpReview: (request: McpReviewRequest) => Promise<IPCResult<McpServerReview>>;
	/** Deletes a review: its author's or an organization administrator's to do */
	deleteMcpReview: (request: McpReviewDeleteRequest) => Promise<IPCResult<boolean>>;
	/** Whether this machine starts a server that must run confined, and why not */
	getMcpSandboxStatus: (request?: McpSandboxRequest) => Promise<IPCResult<McpSandboxStatus>>;
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

		getMcpInstallPolicy: (request: { projectId: string }) =>
			ipcRenderer.invoke(IPC_CHANNELS.MCP_MARKETPLACE_GET_POLICY, request),

		getMcpInstalledWatch: (request: { projectId: string }) =>
			ipcRenderer.invoke(IPC_CHANNELS.MCP_MARKETPLACE_GET_INSTALLED_WATCH, request),

		acknowledgeMcpAlerts: (request: { serverId: string }) =>
			ipcRenderer.invoke(IPC_CHANNELS.MCP_MARKETPLACE_ACKNOWLEDGE_ALERTS, request),

		listMcpReviews: (request: McpReviewListRequest) =>
			ipcRenderer.invoke(IPC_CHANNELS.MCP_MARKETPLACE_LIST_REVIEWS, request),

		putMcpReview: (request: McpReviewRequest) =>
			ipcRenderer.invoke(IPC_CHANNELS.MCP_MARKETPLACE_PUT_REVIEW, request),

		deleteMcpReview: (request: McpReviewDeleteRequest) =>
			ipcRenderer.invoke(IPC_CHANNELS.MCP_MARKETPLACE_DELETE_REVIEW, request),

		getMcpSandboxStatus: (request?: McpSandboxRequest) =>
			ipcRenderer.invoke(IPC_CHANNELS.MCP_MARKETPLACE_GET_SANDBOX, request),
	};
}
