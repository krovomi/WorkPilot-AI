/**
 * MCP tool pins (`apps/backend/mcp_pins`): the tools of each custom MCP
 * server the person approved, and what waits for an approval.
 */

export type McpPinStatus = "approved" | "pending" | "changed";

export interface McpPendingTool {
	name: string;
	change: "added" | "changed";
	description: string;
	previousDescription: string | null;
	inputSchema: Record<string, unknown>;
	/** Signs of a hidden instruction; any of them asks for an explicit confirmation. */
	findings: string[];
}

export interface McpPinnedServer {
	serverId: string;
	status: McpPinStatus;
	approvedAt: string | null;
	approvedBy: string | null;
	lastSeenAt: string | null;
	/** The server's command or URL changed since the approval. */
	programChanged: boolean;
	removed: string[];
	approvedTools: string[];
	pendingTools: McpPendingTool[];
}

export interface McpPinsResult {
	success: boolean;
	data?: McpPinnedServer[];
	error?: string;
	/** The approval was refused because a tool looks poisoned. */
	suspicious?: boolean;
}
