/**
 * Live Companion events
 *
 * The companion watches the project in main and pushes its state, each new
 * suggestion, each takeover proposal and each file change. Nothing in the
 * preload listened, so the dashboard only saw what its polling fetched, and
 * its "recent changes" list, fed by no call at all, stayed empty.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	CompanionState,
	FileChangeEvent,
	LiveSuggestion,
	TakeoverProposal,
} from "../../../shared/types/live-companion";
import { createIpcListener, type IpcListenerCleanup } from "./ipc-utils";

export interface LiveCompanionAPI {
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
	onLiveCompanionStateChanged: (callback) =>
		createIpcListener(IPC_CHANNELS.LIVE_COMPANION_STATE_CHANGED, callback),
	onLiveCompanionSuggestion: (callback) =>
		createIpcListener(IPC_CHANNELS.LIVE_COMPANION_SUGGESTION, callback),
	onLiveCompanionTakeoverProposal: (callback) =>
		createIpcListener(IPC_CHANNELS.LIVE_COMPANION_TAKEOVER_PROPOSAL, callback),
	onLiveCompanionFileChange: (callback) =>
		createIpcListener(IPC_CHANNELS.LIVE_COMPANION_FILE_CHANGE, callback),
});
