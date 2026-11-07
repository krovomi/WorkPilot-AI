/**
 * The voice assistant's shortcut outside the app window (opt-in).
 *
 * Inside the window the renderer listens for the shortcut itself
 * (`renderer/components/voice-assistant/VoiceAssistant.tsx`): that works on
 * every desktop and needs no OS registration. With « Even when WorkPilot is in
 * the background » on, the main process also registers it with the OS, brings
 * the window forward and tells the renderer to open the assistant. A desktop
 * that refuses the registration (another app holds the keys, some Wayland
 * compositors) leaves the in-app shortcut working; the setting reports it.
 */

import { type BrowserWindow, globalShortcut } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { AppSettings } from "../../shared/types/settings";
import { readSettingsFile } from "../settings-utils";
import {
	DEFAULT_VOICE_SHORTCUT,
	parseAccelerator,
	shortcutConflict,
} from "../../shared/utils/voice-shortcut";

/** The part of Electron's `globalShortcut` this module uses (injected for tests). */
export interface ShortcutRegistry {
	register: (accelerator: string, callback: () => void) => boolean;
	unregister: (accelerator: string) => void;
}

export type GlobalShortcutState = "off" | "registered" | "refused";

let registered: string | null = null;
let state: GlobalShortcutState = "off";

/** What the last apply did, for the settings page. */
export function getVoiceGlobalShortcutState(): GlobalShortcutState {
	return state;
}

/**
 * Register (or drop) the system-wide shortcut to match the settings. Safe to
 * call on every save: it only touches the OS when the accelerator or the
 * switch changed.
 */
export function applyVoiceGlobalShortcut(
	settings: Pick<AppSettings, "voiceAssistantShortcut" | "voiceAssistantSystemWide">,
	getWindow: () => BrowserWindow | null,
	getRegistry: () => ShortcutRegistry,
): GlobalShortcutState {
	const wanted = settings.voiceAssistantShortcut || DEFAULT_VOICE_SHORTCUT;
	const enabled =
		settings.voiceAssistantSystemWide === true &&
		parseAccelerator(wanted) !== null &&
		shortcutConflict(wanted) === null;
	if (registered && (!enabled || registered !== wanted)) {
		getRegistry().unregister(registered);
		registered = null;
	}
	if (!enabled) {
		state = "off";
		return state;
	}
	if (registered === wanted) return state;
	let ok = false;
	try {
		ok = getRegistry().register(wanted, () => {
			const window = getWindow();
			if (!window || window.isDestroyed()) return;
			if (window.isMinimized()) window.restore();
			window.show();
			window.focus();
			window.webContents.send(IPC_CHANNELS.VOICE_ASSISTANT_TOGGLE);
		});
	} catch {
		// Electron throws on an accelerator its platform cannot map.
		ok = false;
	}
	registered = ok ? wanted : null;
	state = ok ? "registered" : "refused";
	return state;
}

/**
 * Apply the system-wide shortcut from what `settings.json` holds now: at
 * startup (`registerVoiceAssistantHandlers`), and after each save that touches
 * it (`settings-handlers.ts`).
 */
export function syncVoiceGlobalShortcut(
	getWindow: () => BrowserWindow | null,
	settings: Partial<AppSettings> = (readSettingsFile() ?? {}) as Partial<AppSettings>,
): GlobalShortcutState {
	// Read only when needed: nothing touches the OS while the switch is off.
	return applyVoiceGlobalShortcut(settings, getWindow, () => globalShortcut);
}

/** Forget the registration (the OS drops it with the process anyway). */
export function resetVoiceGlobalShortcutForTests(): void {
	registered = null;
	state = "off";
}
