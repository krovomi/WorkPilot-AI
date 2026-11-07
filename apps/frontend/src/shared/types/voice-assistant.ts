import type { DictationAPI } from "./dictation";

/**
 * What the voice assistant does with a spoken sentence. A closed list: an
 * intent names an action the app already offers through its own UI, never a
 * build, a merge or a deletion (`docs/architecture/voice-assistant.md`).
 */
export type VoiceIntent =
	| { kind: "navigate"; view: string }
	| { kind: "create-task"; title: string; description: string }
	| { kind: "new-task" }
	| { kind: "open-settings" }
	| { kind: "unknown" };

/** A view the assistant may open, as the sidebar offers it right now. */
export interface VoiceDestination {
	/** The `SidebarView` id. */
	id: string;
	/** Its label in the app's language. */
	label: string;
	/** What the view is for, in English, to help a model place a free sentence. */
	hint?: string;
}

/** The model's reading of a sentence, checked by the main process. */
export type VoiceInterpretResult =
	| { success: true; intent: VoiceIntent }
	| { success: false; error: "request" | "unavailable" | "unparsable" };

export interface VoiceAssistantAPI extends DictationAPI {
	/** Ask the feature model (« Voice assistant » in Settings) to read a sentence. */
	interpretVoiceCommand: (
		transcript: string,
		destinations: VoiceDestination[],
		language: string,
		projectId?: string,
	) => Promise<VoiceInterpretResult>;
	/** Whether the system-wide shortcut is registered with the OS right now. */
	getVoiceShortcutStatus: () => Promise<"off" | "registered" | "refused">;
	/** The system-wide shortcut was pressed while the app was in the background. */
	onVoiceAssistantToggle: (callback: () => void) => () => void;
}
