import { create } from "zustand";

/**
 * Whether the voice assistant's panel is open, and whether its continuous mode
 * runs. The panel (`components/voice-assistant/VoiceAssistant.tsx`) and the
 * continuous mode (`VoiceContinuous.tsx`) own their recording; this store only
 * lets the sidebar entry, the command palette, the in-app shortcut and the
 * system-wide shortcut open the panel the same way.
 */
interface VoiceAssistantState {
	isOpen: boolean;
	/** The microphone stays on between sentences (opt-in, from the panel). */
	continuous: boolean;
	/** Bumped on each toggle request, so a second press while open finishes the sentence. */
	pressCount: number;
	/** When the last press was taken (see DOUBLE_PRESS_MS). */
	lastPressAt: number;
	/** The assistant is speaking (`voice-speech.ts`): its microphones ignore what they hear. */
	speaking: boolean;
	/** Task-form dictations running: the assistant's background microphone gives way. */
	formDictations: number;
	/** Pair mode (in the continuous mode): the running task the assistant follows and guides. */
	pairTaskId: string | null;
	/** What that task did last, as the assistant said it. */
	pairNarration: string;
	/** What was said right after the wake phrase, for the panel to read when it opens. */
	pendingCommand: string | null;
	open: () => void;
	/** Open the panel on a sentence already heard (the wake word's). */
	openWith: (command: string) => void;
	/** The sentence the panel opened on, once. */
	takePendingCommand: () => string | null;
	close: () => void;
	/** Close the panel and keep listening, sentence after sentence. */
	startContinuous: () => void;
	stopContinuous: () => void;
	followTask: (taskId: string | null) => void;
	/** Open the panel, or tell an open one that the shortcut was pressed again. */
	press: () => void;
}

/** Two toggles this close together are one key press seen twice (OS + window). */
const DOUBLE_PRESS_MS = 250;

export const useVoiceAssistantStore = create<VoiceAssistantState>((set, get) => ({
	isOpen: false,
	continuous: false,
	pressCount: 0,
	lastPressAt: 0,
	speaking: false,
	formDictations: 0,
	pairTaskId: null,
	pairNarration: "",
	pendingCommand: null,
	open: () => set({ isOpen: true }),
	openWith: (command) => set({ isOpen: true, pendingCommand: command.trim() || null }),
	takePendingCommand: () => {
		const command = get().pendingCommand;
		if (command) set({ pendingCommand: null });
		return command;
	},
	close: () => set({ isOpen: false, pendingCommand: null }),
	startContinuous: () => set({ isOpen: false, continuous: true }),
	stopContinuous: () => set({ continuous: false, pairTaskId: null, pairNarration: "" }),
	followTask: (taskId) => set({ pairTaskId: taskId, pairNarration: "" }),
	press: () => {
		const now = Date.now();
		if (now - get().lastPressAt < DOUBLE_PRESS_MS) return;
		if (!get().isOpen) set({ isOpen: true, lastPressAt: now });
		else set((state) => ({ pressCount: state.pressCount + 1, lastPressAt: now }));
	},
}));

export const openVoiceAssistant = () => useVoiceAssistantStore.getState().open();

/**
 * Only one dictation runs at a time (`dictation-handlers.ts`). The assistant's
 * background microphones (continuous mode, wake word) register how to let go
 * of theirs, and the task form's « Dictate » takes the microphone with
 * `claimMicrophoneForForm`: they let go at once, before its session starts,
 * and come back when it gives the microphone back.
 */
const releasers = new Set<() => void>();

export function holdVoiceMicrophone(release: () => void): () => void {
	releasers.add(release);
	return () => {
		releasers.delete(release);
	};
}

export function claimMicrophoneForForm(): () => void {
	useVoiceAssistantStore.setState((state) => ({ formDictations: state.formDictations + 1 }));
	for (const release of [...releasers]) release();
	let given = false;
	return () => {
		if (given) return;
		given = true;
		useVoiceAssistantStore.setState((state) => ({
			formDictations: Math.max(0, state.formDictations - 1),
		}));
	};
}

/**
 * The system-wide shortcut (main process, opt-in) arrives as an event.
 * Registered once for the window's life by `global-listeners.ts`.
 */
export function setupVoiceAssistantListeners(): () => void {
	return window.electronAPI.onVoiceAssistantToggle(() => {
		useVoiceAssistantStore.getState().press();
	});
}
