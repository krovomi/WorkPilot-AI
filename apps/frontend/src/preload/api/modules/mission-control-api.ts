/**
 * Mission Control: the state is proxied to the local backend by the main
 * process, which also runs each agent's model call with its provider's
 * credentials (`main/mission-control/`).
 */
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult } from "../../../shared/types";
import type {
	MissionControlAgent,
	MissionControlNewAgent,
	MissionControlSession,
	MissionControlStartRequest,
	MissionControlState,
} from "../../../shared/types/mission-control";
import { invokeIpc } from "./ipc-utils";

export interface MissionControlAPI {
	missionControlGetState: () => Promise<IPCResult<MissionControlState>>;
	missionControlStartSession: () => Promise<IPCResult<MissionControlSession>>;
	/** Stops every running agent, then the session. */
	missionControlStopSession: () => Promise<IPCResult>;
	missionControlCreateAgent: (
		agent: MissionControlNewAgent,
	) => Promise<IPCResult<MissionControlAgent>>;
	missionControlRemoveAgent: (agentId: string) => Promise<IPCResult>;
	/** Resolves once the agent has started; its answer arrives in the state. */
	missionControlStartAgent: (request: MissionControlStartRequest) => Promise<IPCResult>;
	missionControlStopAgent: (agentId: string) => Promise<IPCResult>;
}

export function createMissionControlAPI(): MissionControlAPI {
	return {
		missionControlGetState: () => invokeIpc(IPC_CHANNELS.MISSION_CONTROL_GET_STATE),
		missionControlStartSession: () => invokeIpc(IPC_CHANNELS.MISSION_CONTROL_START_SESSION),
		missionControlStopSession: () => invokeIpc(IPC_CHANNELS.MISSION_CONTROL_STOP_SESSION),
		missionControlCreateAgent: (agent) =>
			invokeIpc(IPC_CHANNELS.MISSION_CONTROL_CREATE_AGENT, agent),
		missionControlRemoveAgent: (agentId) =>
			invokeIpc(IPC_CHANNELS.MISSION_CONTROL_REMOVE_AGENT, agentId),
		missionControlStartAgent: (request) =>
			invokeIpc(IPC_CHANNELS.MISSION_CONTROL_START_AGENT, request),
		missionControlStopAgent: (agentId) =>
			invokeIpc(IPC_CHANNELS.MISSION_CONTROL_STOP_AGENT, agentId),
	};
}
