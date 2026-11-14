/**
 * Live Companion API
 *
 * The companion watches the project in main (`main/live-companion-service.ts`)
 * and pushes its state, each new suggestion, each takeover proposal and each
 * file change. The calls used to go through the generic `invoke` passthrough
 * (security.md, S6: a channel is a typed method); they are typed here now.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { IPCResult } from "../../../shared/types/common";
import type {
	CompanionConfig,
	CompanionState,
	FileChangeEvent,
	LiveSuggestion,
	TakeoverProposal,
} from "../../../shared/types/live-companion";
import {
	createIpcListener,
	type IpcListenerCleanup,
	invokeIpc,
} from "./ipc-utils";

export interface LiveCompanionAPI {
	liveCompanionStart: (projectDir: string) => Promise<IPCResult>;
	liveCompanionStop: () => Promise<IPCResult>;
	liveCompanionGetState: () => Promise<IPCResult<CompanionState>>;
	liveCompanionGetConfig: () => Promise<IPCResult<CompanionConfig>>;
	liveCompanionUpdateConfig: (
		updates: Partial<CompanionConfig>,
	) => Promise<IPCResult<CompanionConfig>>;
	liveCompanionGetSuggestions: (
		projectDir?: string,
	) => Promise<IPCResult<LiveSuggestion[]>>;
	liveCompanionDismissSuggestion: (suggestionId: string) => Promise<IPCResult>;
	liveCompanionApplySuggestion: (suggestionId: string) => Promise<IPCResult>;
	liveCompanionGetTakeovers: (
		projectDir?: string,
	) => Promise<IPCResult<TakeoverProposal[]>>;
	liveCompanionAcceptTakeover: (proposalId: string) => Promise<IPCResult>;
	liveCompanionDeclineTakeover: (proposalId: string) => Promise<IPCResult>;
	onLiveCompanionStateChanged: (
		callback: (state: CompanionState) => void,
	) => IpcListenerCleanup;
	onLiveCompanionSuggestion: (
		callback: (suggestion: LiveSuggestion) => void,
	) => IpcListenerCleanup;
	onLiveCompanionTakeoverProposal: (
		callback: (proposal: TakeoverProposal) => void,
	) => IpcListenerCleanup;
	onLiveCompanionFileChange: (
		callback: (event: FileChangeEvent) => void,
	) => IpcListenerCleanup;
}

export const createLiveCompanionAPI = (): LiveCompanionAPI => ({
	liveCompanionStart: (projectDir) =>
		invokeIpc(IPC_CHANNELS.LIVE_COMPANION_START, projectDir),
	liveCompanionStop: () => invokeIpc(IPC_CHANNELS.LIVE_COMPANION_STOP),
	liveCompanionGetState: () => invokeIpc(IPC_CHANNELS.LIVE_COMPANION_GET_STATE),
	liveCompanionGetConfig: () =>
		invokeIpc(IPC_CHANNELS.LIVE_COMPANION_GET_CONFIG),
	liveCompanionUpdateConfig: (updates) =>
		invokeIpc(IPC_CHANNELS.LIVE_COMPANION_UPDATE_CONFIG, updates),
	liveCompanionGetSuggestions: (projectDir) =>
		invokeIpc(IPC_CHANNELS.LIVE_COMPANION_GET_SUGGESTIONS, projectDir),
	liveCompanionDismissSuggestion: (suggestionId) =>
		invokeIpc(IPC_CHANNELS.LIVE_COMPANION_DISMISS_SUGGESTION, suggestionId),
	liveCompanionApplySuggestion: (suggestionId) =>
		invokeIpc(IPC_CHANNELS.LIVE_COMPANION_APPLY_SUGGESTION, suggestionId),
	liveCompanionGetTakeovers: (projectDir) =>
		invokeIpc(IPC_CHANNELS.LIVE_COMPANION_GET_TAKEOVERS, projectDir),
	liveCompanionAcceptTakeover: (proposalId) =>
		invokeIpc(IPC_CHANNELS.LIVE_COMPANION_ACCEPT_TAKEOVER, proposalId),
	liveCompanionDeclineTakeover: (proposalId) =>
		invokeIpc(IPC_CHANNELS.LIVE_COMPANION_DECLINE_TAKEOVER, proposalId),
	onLiveCompanionStateChanged: (callback) =>
		createIpcListener(IPC_CHANNELS.LIVE_COMPANION_STATE_CHANGED, callback),
	onLiveCompanionSuggestion: (callback) =>
		createIpcListener(IPC_CHANNELS.LIVE_COMPANION_SUGGESTION, callback),
	onLiveCompanionTakeoverProposal: (callback) =>
		createIpcListener(IPC_CHANNELS.LIVE_COMPANION_TAKEOVER_PROPOSAL, callback),
	onLiveCompanionFileChange: (callback) =>
		createIpcListener(IPC_CHANNELS.LIVE_COMPANION_FILE_CHANGE, callback),
});
