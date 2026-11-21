/**
 * Agent Replay and Session History — renderer-side bridge.
 *
 * Main reads the recorded sessions from the local backend; the renderer never
 * fetches the backend itself (see `main/ipc-handlers/replay-handlers.ts`).
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	ReplayBookmark,
	ReplayBookmarkRequest,
	ReplayExportOptions,
	ReplayFileResult,
	ReplayImportResult,
	ReplaySummary,
	ReplaySummaryRequest,
	ReplayTeamShareListResult,
	ReplayTeamShareRequest,
	ReplayTeamShareResult,
	ReplayVideoOptions,
	ReplayVideoResult,
} from "../../../shared/types/replay-share";
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
	/** Masked by the backend, written where the person chooses (#347). */
	exportReplaySession: (
		sessionId: string,
		options: ReplayExportOptions,
	) => Promise<ReplayFileResult>;
	/** A `.wpreplay` the person picks, stored as a new session. */
	importReplaySession: () => Promise<ReplayImportResult>;
	addReplayBookmark: (
		sessionId: string,
		bookmark: ReplayBookmarkRequest,
	) => Promise<ReplayResult<{ bookmark: ReplayBookmark }>>;
	removeReplayBookmark: (
		sessionId: string,
		bookmarkId: string,
	) => Promise<ReplayResult<object>>;
	/** The masked page played step by step, as a WebM the person saves. */
	exportReplayVideo: (
		sessionId: string,
		options: ReplayVideoOptions,
	) => Promise<ReplayVideoResult>;
	/** A model's summary of the steps, for a session with no thinking trace. */
	summarizeReplaySession: (
		sessionId: string,
		request: ReplaySummaryRequest,
	) => Promise<ReplayResult<{ summary: ReplaySummary }>>;
	/** Leave the masked session with a server project; answers its link. */
	shareReplayToTeam: (
		sessionId: string,
		request: ReplayTeamShareRequest,
	) => Promise<ReplayTeamShareResult>;
	listReplayTeamShares: (projectId: string) => Promise<ReplayTeamShareListResult>;
	revokeReplayTeamShare: (
		projectId: string,
		shareId: string,
	) => Promise<ReplayResult<object>>;
	/** A pasted team link, opened from this server and imported here. */
	openReplayTeamShare: (link: string) => Promise<ReplayImportResult>;
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
	exportReplaySession: (sessionId, options) =>
		invokeIpc(IPC_CHANNELS.REPLAY_EXPORT_SESSION, sessionId, options),
	importReplaySession: () => invokeIpc(IPC_CHANNELS.REPLAY_IMPORT_SESSION),
	addReplayBookmark: (sessionId, bookmark) =>
		invokeIpc(IPC_CHANNELS.REPLAY_ADD_BOOKMARK, sessionId, bookmark),
	removeReplayBookmark: (sessionId, bookmarkId) =>
		invokeIpc(IPC_CHANNELS.REPLAY_REMOVE_BOOKMARK, sessionId, bookmarkId),
	exportReplayVideo: (sessionId, options) =>
		invokeIpc(IPC_CHANNELS.REPLAY_EXPORT_VIDEO, sessionId, options),
	summarizeReplaySession: (sessionId, request) =>
		invokeIpc(IPC_CHANNELS.REPLAY_SUMMARIZE_SESSION, sessionId, request),
	shareReplayToTeam: (sessionId, request) =>
		invokeIpc(IPC_CHANNELS.REPLAY_SHARE_TO_TEAM, sessionId, request),
	listReplayTeamShares: (projectId) =>
		invokeIpc(IPC_CHANNELS.REPLAY_LIST_TEAM_SHARES, projectId),
	revokeReplayTeamShare: (projectId, shareId) =>
		invokeIpc(IPC_CHANNELS.REPLAY_REVOKE_TEAM_SHARE, projectId, shareId),
	openReplayTeamShare: (link) => invokeIpc(IPC_CHANNELS.REPLAY_OPEN_TEAM_SHARE, link),
});
