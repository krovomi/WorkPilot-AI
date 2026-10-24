/**
 * Agent Debugger API — renderer-side bridge.
 *
 * Provider-agnostic: the debugger operates on Claude Agent SDK hook events,
 * which look identical regardless of the underlying provider (Anthropic,
 * OpenAI, Copilot, Windsurf, Ollama, …).
 */

import { invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

export interface BreakpointSpec {
	id: string;
	tool: string;
	path_pattern?: string;
	content_pattern?: string;
	command_pattern?: string;
	enabled?: boolean;
}

export interface DebugFrameDTO {
	frame_id: string;
	session_id: string;
	breakpoint_id: string;
	tool_name: string;
	tool_input: Record<string, unknown>;
	captured_at: number;
	context_snapshot: Record<string, unknown>;
}

export type ResumeAction = "continue" | "skip" | "modify";

export interface DebugSessionMeta {
	project?: string;
	spec?: string;
	agent_type?: string;
	pid?: number;
	heartbeat?: number;
}

export interface DebugSessionSummary {
	session_id: string;
	breakpoints: number;
	frames: number;
	updated_at?: number;
	active?: boolean;
	meta?: DebugSessionMeta;
}

export interface AgentDebuggerAPI {
	listDebugSessions: () => Promise<{ sessions: DebugSessionSummary[] }>;
	getDebugState: (
		sessionId: string,
	) => Promise<{ breakpoints: BreakpointSpec[]; frames: DebugFrameDTO[] }>;
	attachDebugger: (sessionId: string) => Promise<{ ok: boolean }>;
	detachDebugger: (sessionId: string) => Promise<{ ok: boolean }>;
	listBreakpoints: (
		sessionId: string,
	) => Promise<{ breakpoints: BreakpointSpec[] }>;
	setBreakpoint: (
		sessionId: string,
		breakpoint: BreakpointSpec,
	) => Promise<{ ok: boolean; breakpoint_id: string }>;
	removeBreakpoint: (
		sessionId: string,
		id: string,
	) => Promise<{ ok: boolean }>;
	listDebugFrames: (
		sessionId: string,
	) => Promise<{ frames: DebugFrameDTO[] }>;
	resumeFrame: (
		sessionId: string,
		frameId: string,
		action: ResumeAction,
		options?: {
			toolInput?: Record<string, unknown>;
			reason?: string;
		},
	) => Promise<{ ok: boolean }>;
}

export const createAgentDebuggerAPI = (): AgentDebuggerAPI => ({
	listDebugSessions: () => invokeIpc(IPC_CHANNELS.AGENT_DEBUGGER_LIST_SESSIONS, {}),
	getDebugState: (sessionId) =>
		invokeIpc(IPC_CHANNELS.AGENT_DEBUGGER_GET_STATE, { sessionId }),
	attachDebugger: (sessionId) =>
		invokeIpc(IPC_CHANNELS.AGENT_DEBUGGER_ATTACH, { sessionId }),
	detachDebugger: (sessionId) =>
		invokeIpc(IPC_CHANNELS.AGENT_DEBUGGER_DETACH, { sessionId }),
	listBreakpoints: (sessionId) =>
		invokeIpc(IPC_CHANNELS.AGENT_DEBUGGER_LIST_BREAKPOINTS, { sessionId }),
	setBreakpoint: (sessionId, breakpoint) =>
		invokeIpc(IPC_CHANNELS.AGENT_DEBUGGER_SET_BREAKPOINT, { sessionId, breakpoint }),
	removeBreakpoint: (sessionId, id) =>
		invokeIpc(IPC_CHANNELS.AGENT_DEBUGGER_REMOVE_BREAKPOINT, { sessionId, id }),
	listDebugFrames: (sessionId) =>
		invokeIpc(IPC_CHANNELS.AGENT_DEBUGGER_LIST_FRAMES, { sessionId }),
	resumeFrame: (sessionId, frameId, action, options) =>
		invokeIpc(IPC_CHANNELS.AGENT_DEBUGGER_RESUME, {
			sessionId,
			frameId,
			action,
			toolInput: options?.toolInput,
			reason: options?.reason,
		}),
});
