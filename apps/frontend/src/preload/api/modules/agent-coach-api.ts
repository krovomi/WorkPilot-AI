/**
 * Agent Coach API
 *
 * Renderer-side bridge to the agent coach runner which analyses persisted
 * agent run records and returns a coaching report.
 */

import type {
	CoachCheckResult,
	CoachProfileState,
	CoachReport,
	StylePreferences,
} from "../../../shared/types/agent-coach";
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
	getCoachProfile: (options: AgentCoachRunOptions) => Promise<CoachProfileState>;
	buildCoachProfile: (options: AgentCoachRunOptions) => Promise<CoachProfileState>;
	setCoachPreferences: (options: AgentCoachRunOptions & { preferences: StylePreferences }) => Promise<CoachProfileState>;
	exportCoachProfile: (options: AgentCoachRunOptions) => Promise<string | null>;
	importCoachProfile: (options: AgentCoachRunOptions) => Promise<CoachProfileState | null>;
	checkCoachTask: (options: AgentCoachRunOptions & { spec: string }) => Promise<CoachCheckResult>;
}

export const createAgentCoachAPI = (): AgentCoachAPI => ({
	runAgentCoachScan: (options: AgentCoachRunOptions) =>
		invokeIpc<AgentCoachResult>(IPC_CHANNELS.AGENT_COACH_RUN, options),

	cancelAgentCoachScan: () => invokeIpc<boolean>(IPC_CHANNELS.AGENT_COACH_CANCEL),

	getCoachProfile: (options) => invokeIpc<CoachProfileState>(IPC_CHANNELS.COACH_PROFILE_GET, options),
	buildCoachProfile: (options) => invokeIpc<CoachProfileState>(IPC_CHANNELS.COACH_PROFILE_BUILD, options),
	setCoachPreferences: (options) => invokeIpc<CoachProfileState>(IPC_CHANNELS.COACH_PROFILE_SET, options),
	exportCoachProfile: (options) => invokeIpc<string | null>(IPC_CHANNELS.COACH_PROFILE_EXPORT, options),
	importCoachProfile: (options) => invokeIpc<CoachProfileState | null>(IPC_CHANNELS.COACH_PROFILE_IMPORT, options),
	checkCoachTask: (options) => invokeIpc<CoachCheckResult>(IPC_CHANNELS.COACH_PROFILE_CHECK, options),

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
