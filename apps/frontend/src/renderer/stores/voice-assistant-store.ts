import { create } from "zustand";

/**
 * Whether the voice assistant's panel is open. The panel itself
 * (`components/voice-assistant/VoiceAssistant.tsx`) owns the recording; this
 * store only lets the sidebar entry, the command palette, the in-app shortcut
 * and the system-wide shortcut open it the same way.
 */
interface VoiceAssistantState {
	isOpen: boolean;
	/** Bumped on each toggle request, so a second press while open finishes the sentence. */
	pressCount: number;
	/** When the last press was taken (see DOUBLE_PRESS_MS). */
	lastPressAt: number;
	open: () => void;
	close: () => void;
	/** Open the panel, or tell an open one that the shortcut was pressed again. */
	press: () => void;
}

/** Two toggles this close together are one key press seen twice (OS + window). */
const DOUBLE_PRESS_MS = 250;

export const useVoiceAssistantStore = create<VoiceAssistantState>((set, get) => ({
	isOpen: false,
	pressCount: 0,
	lastPressAt: 0,
	open: () => set({ isOpen: true }),
	close: () => set({ isOpen: false }),
	press: () => {
		const now = Date.now();
		if (now - get().lastPressAt < DOUBLE_PRESS_MS) return;
		if (!get().isOpen) set({ isOpen: true, lastPressAt: now });
		else set((state) => ({ pressCount: state.pressCount + 1, lastPressAt: now }));
	},
}));

export const openVoiceAssistant = () => useVoiceAssistantStore.getState().open();

/**
 * The system-wide shortcut (main process, opt-in) arrives as an event.
 * Registered once for the window's life by `global-listeners.ts`.
 */
export function setupVoiceAssistantListeners(): () => void {
	return window.electronAPI.onVoiceAssistantToggle(() => {
		useVoiceAssistantStore.getState().press();
	});
}
