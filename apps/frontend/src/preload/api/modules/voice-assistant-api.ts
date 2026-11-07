/**
 * Voice assistant API for the preload script: the local dictation session the
 * assistant (and the task form) records with, the interpretation of a
 * sentence, and the system-wide shortcut's event.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { VoiceAssistantAPI } from "../../../shared/types/voice-assistant";
import { createIpcListener, invokeIpc } from "./ipc-utils";

export type { VoiceAssistantAPI };

export function createVoiceAssistantAPI(): VoiceAssistantAPI {
	return {
		dictationStart: (id, download, projectPath) =>
			invokeIpc(IPC_CHANNELS.DICTATION_START, id, download, projectPath),
		dictationTranscribe: (id, audio, language) =>
			invokeIpc(IPC_CHANNELS.DICTATION_TRANSCRIBE, id, audio, language),
		dictationCancel: (id) => invokeIpc(IPC_CHANNELS.DICTATION_CANCEL, id),
		interpretVoiceCommand: (transcript, destinations, language, projectId) =>
			invokeIpc(
				IPC_CHANNELS.VOICE_ASSISTANT_INTERPRET,
				transcript,
				destinations,
				language,
				projectId,
			),
		getVoiceShortcutStatus: () =>
			invokeIpc(IPC_CHANNELS.VOICE_ASSISTANT_SHORTCUT_STATUS),
		onVoiceAssistantToggle: (callback) =>
			createIpcListener(IPC_CHANNELS.VOICE_ASSISTANT_TOGGLE, callback),
	};
}
