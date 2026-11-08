/**
 * Agent CLI API for the renderer: is a coding-agent CLI installed, which
 * version, what an ACP agent declares it can do, installing a missing one and
 * updating an installed one (hermes included).
 */

import type {
	AcpAgentDeclaration,
	AgentCliInstallResult,
	AgentCliStatus,
	AgentCliTool,
} from "../../../shared/types/agent-cli";
import type {
	CliUpdateResult,
	CliUpdateStatus,
	UpdatableCliTool,
} from "../../../shared/types/cli-update";
import { invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface AgentCliAPI {
	checkAgentCli: (tool: AgentCliTool) => Promise<AgentCliStatus>;
	probeAcpAgent: (tool: AgentCliTool) => Promise<AcpAgentDeclaration>;
	installAgentCli: (tool: AgentCliTool) => Promise<AgentCliInstallResult>;
	/** Installed version against the latest published one (agent CLIs and hermes). */
	checkCliUpdate: (tool: UpdatableCliTool) => Promise<CliUpdateStatus>;
	/** Update an installed CLI with whoever owns it, then check it again. */
	updateCli: (tool: UpdatableCliTool) => Promise<CliUpdateResult>;
}

export const createAgentCliAPI = (): AgentCliAPI => ({
	checkAgentCli: (tool: AgentCliTool): Promise<AgentCliStatus> =>
		invokeIpc<AgentCliStatus>(IPC_CHANNELS.AGENT_CLI_CHECK, tool),
	probeAcpAgent: (tool: AgentCliTool): Promise<AcpAgentDeclaration> =>
		invokeIpc<AcpAgentDeclaration>(IPC_CHANNELS.AGENT_CLI_PROBE_ACP, tool),
	installAgentCli: (tool: AgentCliTool): Promise<AgentCliInstallResult> =>
		invokeIpc<AgentCliInstallResult>(IPC_CHANNELS.AGENT_CLI_INSTALL, tool),
	checkCliUpdate: (tool: UpdatableCliTool): Promise<CliUpdateStatus> =>
		invokeIpc<CliUpdateStatus>(IPC_CHANNELS.AGENT_CLI_UPDATE_CHECK, tool),
	updateCli: (tool: UpdatableCliTool): Promise<CliUpdateResult> =>
		invokeIpc<CliUpdateResult>(IPC_CHANNELS.AGENT_CLI_UPDATE, tool),
});
