/**
 * The phone's own copy of the theme, read at launch before any network, so
 * the first screen already has the person's colours and the app works
 * offline. `pending` marks a choice the server has not taken yet (a save
 * made offline): the next sync sends it instead of reading the server's.
 *
 * Not a secret, but expo-secure-store is the one store already in the app
 * (no AsyncStorage): a few bytes in the Keychain / Keystore. On the web
 * preview, where there is no secure store, the browser's localStorage.
 */

import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { parsePrefs, type ThemePrefs } from "./theme-ids";

const KEY = "workpilot.uiPrefs";

const OPTIONS: SecureStore.SecureStoreOptions = {
	keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export interface StoredPrefs extends ThemePrefs {
	pending: boolean;
}

function webStorage(): Storage | null {
	try {
		return (globalThis as { localStorage?: Storage }).localStorage ?? null;
	} catch {
		return null;
	}
}

async function readRaw(): Promise<string | null> {
	if (Platform.OS === "web") return webStorage()?.getItem(KEY) ?? null;
	return await SecureStore.getItemAsync(KEY, OPTIONS);
}

async function writeRaw(value: string): Promise<void> {
	if (Platform.OS === "web") webStorage()?.setItem(KEY, value);
	else await SecureStore.setItemAsync(KEY, value, OPTIONS);
}

/** The stored copy, or null when there is none or it cannot be read. */
export async function loadPrefs(): Promise<StoredPrefs | null> {
	try {
		const raw = await readRaw();
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		const prefs = parsePrefs(parsed);
		if (!prefs) return null;
		return { ...prefs, pending: (parsed as { pending?: unknown }).pending === true };
	} catch {
		// An unreadable entry is no choice made, never a crash at launch.
		return null;
	}
}

/** Keep the copy; a failed write only loses it for the next launch. */
export async function savePrefs(prefs: StoredPrefs): Promise<void> {
	try {
		await writeRaw(
			JSON.stringify({ theme: prefs.theme, colorTheme: prefs.colorTheme, pending: prefs.pending }),
		);
	} catch {
		// The theme still applies for this session.
	}
}
