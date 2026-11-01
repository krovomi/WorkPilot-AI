/**
 * Agent CLI API for the renderer: is a coding-agent CLI installed, which
 * version, what an ACP agent declares it can do, and installing a missing one.
 */

import type {
	AcpAgentDeclaration,
	AgentCliInstallResult,
	AgentCliStatus,
	AgentCliTool,
} from "../../../shared/types/agent-cli";
import { invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface AgentCliAPI {
	checkAgentCli: (tool: AgentCliTool) => Promise<AgentCliStatus>;
	probeAcpAgent: (tool: AgentCliTool) => Promise<AcpAgentDeclaration>;
	installAgentCli: (tool: AgentCliTool) => Promise<AgentCliInstallResult>;
}

export const createAgentCliAPI = (): AgentCliAPI => ({
	checkAgentCli: (tool: AgentCliTool): Promise<AgentCliStatus> =>
		invokeIpc<AgentCliStatus>(IPC_CHANNELS.AGENT_CLI_CHECK, tool),
	probeAcpAgent: (tool: AgentCliTool): Promise<AcpAgentDeclaration> =>
		invokeIpc<AcpAgentDeclaration>(IPC_CHANNELS.AGENT_CLI_PROBE_ACP, tool),
	installAgentCli: (tool: AgentCliTool): Promise<AgentCliInstallResult> =>
		invokeIpc<AgentCliInstallResult>(IPC_CHANNELS.AGENT_CLI_INSTALL, tool),
});
