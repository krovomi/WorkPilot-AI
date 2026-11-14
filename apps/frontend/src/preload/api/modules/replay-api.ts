/**
 * Agent Replay and Session History — renderer-side bridge.
 *
 * Main reads the recorded sessions from the local backend; the renderer never
 * fetches the backend itself (see `main/ipc-handlers/replay-handlers.ts`).
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { invokeIpc } from "./ipc-utils";

/** A backend answer: its JSON body, or why there is none. */
export type ReplayResult<T> =
	| ({ success: true } & T)
	| { success: false; error: string; unreachable?: true };

export interface ReplayBreakpointRequest {
	breakpoint_type: string;
	condition: string;
	description: string;
}

export interface ReplayAPI {
	listReplaySessions: <T>() => Promise<ReplayResult<T>>;
	getReplaySession: <T>(sessionId: string) => Promise<ReplayResult<T>>;
	deleteReplaySession: (sessionId: string) => Promise<ReplayResult<object>>;
	getReplayHeatmap: <T>(sessionId: string) => Promise<ReplayResult<T>>;
	compareReplaySessions: <T>(
		sessionAId: string,
		sessionBId: string,
	) => Promise<ReplayResult<T>>;
	addReplayBreakpoint: <T>(
		sessionId: string,
		breakpoint: ReplayBreakpointRequest,
	) => Promise<ReplayResult<T>>;
	removeReplayBreakpoint: (
		sessionId: string,
		breakpointId: string,
	) => Promise<ReplayResult<object>>;
	listSessionHistory: <T>(projectId: string) => Promise<ReplayResult<T>>;
}

export const createReplayAPI = (): ReplayAPI => ({
	listReplaySessions: () => invokeIpc(IPC_CHANNELS.REPLAY_LIST_SESSIONS),
	getReplaySession: (sessionId) =>
		invokeIpc(IPC_CHANNELS.REPLAY_GET_SESSION, sessionId),
	deleteReplaySession: (sessionId) =>
		invokeIpc(IPC_CHANNELS.REPLAY_DELETE_SESSION, sessionId),
	getReplayHeatmap: (sessionId) =>
		invokeIpc(IPC_CHANNELS.REPLAY_GET_HEATMAP, sessionId),
	compareReplaySessions: (sessionAId, sessionBId) =>
		invokeIpc(IPC_CHANNELS.REPLAY_COMPARE, sessionAId, sessionBId),
	addReplayBreakpoint: (sessionId, breakpoint) =>
		invokeIpc(IPC_CHANNELS.REPLAY_ADD_BREAKPOINT, sessionId, breakpoint),
	removeReplayBreakpoint: (sessionId, breakpointId) =>
		invokeIpc(IPC_CHANNELS.REPLAY_REMOVE_BREAKPOINT, sessionId, breakpointId),
	listSessionHistory: (projectId) =>
		invokeIpc(IPC_CHANNELS.SESSION_HISTORY_LIST, projectId),
});
