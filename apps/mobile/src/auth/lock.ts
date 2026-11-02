/**
 * The app's lock: Face ID, Touch ID or a fingerprint, with the device's
 * passcode as fallback.
 *
 * Two settings, kept on the phone (expo-secure-store, never backed up):
 * - `atLaunch`: ask when the app opens, and again when it comes back after a
 *   while in the background (`RELOCK_AFTER_MS`). Off by default.
 * - `sensitive`: ask before an action that cannot be taken back from the
 *   phone: merge, create a pull request, delete a card, approve a plan from a
 *   notification. On by default.
 *
 * A phone with no biometrics enrolled and no passcode cannot be asked: the
 * lock then lets everything through, as the OS would. The server checks every
 * action again; the lock only stops someone holding an unlocked phone.
 */

import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export interface LockSettings {
	atLaunch: boolean;
	sensitive: boolean;
}

export const DEFAULT_LOCK: LockSettings = { atLaunch: false, sensitive: true };
/** How long the app may stay in the background before it locks again. */
export const RELOCK_AFTER_MS = 60_000;

const KEY = "workpilot.lock";
const OPTIONS: SecureStore.SecureStoreOptions = {
	keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
const native = Platform.OS === "ios" || Platform.OS === "android";

export async function loadLockSettings(): Promise<LockSettings> {
	if (!native) return DEFAULT_LOCK;
	try {
		const raw = await SecureStore.getItemAsync(KEY, OPTIONS);
		if (!raw) return DEFAULT_LOCK;
		const value = JSON.parse(raw) as Partial<Record<keyof LockSettings, unknown>>;
		return {
			atLaunch: typeof value.atLaunch === "boolean" ? value.atLaunch : DEFAULT_LOCK.atLaunch,
			sensitive: typeof value.sensitive === "boolean" ? value.sensitive : DEFAULT_LOCK.sensitive,
		};
	} catch {
		return DEFAULT_LOCK;
	}
}

export async function saveLockSettings(settings: LockSettings): Promise<void> {
	if (!native) return;
	await SecureStore.setItemAsync(KEY, JSON.stringify(settings), OPTIONS);
}

/** Whether this phone can ask: biometrics enrolled, or at least a passcode. */
export async function canAsk(): Promise<boolean> {
	if (!native) return false;
	try {
		const level = await LocalAuthentication.getEnrolledLevelAsync();
		return level !== LocalAuthentication.SecurityLevel.NONE;
	} catch {
		return false;
	}
}

/**
 * Ask the person to prove it is them. True when they did, or when the phone
 * cannot ask; false when they cancelled or failed.
 */
export async function authenticate(promptMessage: string, cancelLabel: string): Promise<boolean> {
	if (!(await canAsk())) return true;
	const result = await LocalAuthentication.authenticateAsync({
		promptMessage,
		cancelLabel,
		disableDeviceFallback: false,
	});
	return result.success;
}

/** Ask before a sensitive action, when the person keeps that setting on. */
export async function confirmSensitive(promptMessage: string, cancelLabel: string): Promise<boolean> {
	const settings = await loadLockSettings();
	if (!settings.sensitive) return true;
	return authenticate(promptMessage, cancelLabel);
}
