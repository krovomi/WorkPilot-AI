/**
 * Agent Coach API
 *
 * Renderer-side bridge to the agent coach runner which analyses persisted
 * agent run records and returns a coaching report.
 */

import type { CoachReport } from "../../../shared/types/agent-coach";
import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface AgentCoachRunOptions {
	projectPath: string;
}

export interface AgentCoachResult {
	report: CoachReport;
}

export interface AgentCoachEvent {
	type: "start" | "progress" | "complete";
	data: { status?: string; totalRuns?: number; tips?: number };
}

export interface AgentCoachAPI {
	runAgentCoachScan: (
		options: AgentCoachRunOptions,
	) => Promise<AgentCoachResult>;
	cancelAgentCoachScan: () => Promise<boolean>;
	onAgentCoachEvent: (
		callback: (event: AgentCoachEvent) => void,
	) => () => void;
	onAgentCoachResult: (
		callback: (result: AgentCoachResult) => void,
	) => () => void;
	onAgentCoachError: (callback: (error: string) => void) => () => void;
}

export const createAgentCoachAPI = (): AgentCoachAPI => ({
	runAgentCoachScan: (options: AgentCoachRunOptions) =>
		invokeIpc<AgentCoachResult>(IPC_CHANNELS.AGENT_COACH_RUN, options),

	cancelAgentCoachScan: () => invokeIpc<boolean>(IPC_CHANNELS.AGENT_COACH_CANCEL),

	onAgentCoachEvent: (callback) =>
		createIpcListener<[AgentCoachEvent]>(IPC_CHANNELS.AGENT_COACH_EVENT, (payload) =>
			callback(payload),
		),

	onAgentCoachResult: (callback) =>
		createIpcListener<[AgentCoachResult]>(IPC_CHANNELS.AGENT_COACH_RESULT, (payload) =>
			callback(payload),
		),

	onAgentCoachError: (callback) =>
		createIpcListener<[string]>(IPC_CHANNELS.AGENT_COACH_ERROR, (payload) =>
			callback(payload),
		),
});
