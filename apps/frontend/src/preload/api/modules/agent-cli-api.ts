/**
 * Agent CLI API for the renderer: is OpenCode (`opencode`) or Google
 * Antigravity (`agy`) installed, and which version.
 */

import type { AgentCliStatus, AgentCliTool } from "../../../shared/types/agent-cli";
import { invokeIpc } from "./ipc-utils";

export interface AgentCliAPI {
	checkAgentCli: (tool: AgentCliTool) => Promise<AgentCliStatus>;
}

export const createAgentCliAPI = (): AgentCliAPI => ({
	checkAgentCli: (tool: AgentCliTool): Promise<AgentCliStatus> =>
		invokeIpc<AgentCliStatus>("agentCli:check", tool),
});
