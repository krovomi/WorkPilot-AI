/**
 * Agent CLI API for the renderer: is OpenCode (`opencode`) or Google
 * Antigravity (`agy`) installed, and which version.
 */

import type { AgentCliStatus, AgentCliTool } from "../../../shared/types/agent-cli";
import { invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface AgentCliAPI {
	checkAgentCli: (tool: AgentCliTool) => Promise<AgentCliStatus>;
}

export const createAgentCliAPI = (): AgentCliAPI => ({
	checkAgentCli: (tool: AgentCliTool): Promise<AgentCliStatus> =>
		invokeIpc<AgentCliStatus>(IPC_CHANNELS.AGENT_CLI_CHECK, tool),
});
