/**
 * Where the phone keeps the session between launches: the server's address,
 * the refresh token and the organization the person last acted in.
 *
 * The refresh token lives in the iOS Keychain or the Android Keystore
 * (expo-secure-store), readable only by this app, only after the first
 * unlock of the device, and never backed up to another device. The access
 * token is never stored: it lives in memory and is minted again from the
 * refresh token at launch. On the web build (a preview, not a shipped
 * target) there is no secure store, so nothing is kept.
 */

import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const KEYS = {
	serverUrl: "workpilot.serverUrl",
	refreshToken: "workpilot.refreshToken",
	orgId: "workpilot.orgId",
} as const;

export interface StoredSession {
	serverUrl: string | null;
	refreshToken: string | null;
	orgId: string | null;
}

const OPTIONS: SecureStore.SecureStoreOptions = {
	keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

const secure = Platform.OS !== "web";

async function read(key: string): Promise<string | null> {
	if (!secure) return null;
	try {
		return await SecureStore.getItemAsync(key, OPTIONS);
	} catch {
		// A Keychain entry the OS can no longer decrypt (restored backup,
		// changed passcode) is a signed-out session, not a crash.
		return null;
	}
}

async function write(key: string, value: string | null): Promise<void> {
	if (!secure) return;
	if (value === null) await SecureStore.deleteItemAsync(key, OPTIONS);
	else await SecureStore.setItemAsync(key, value, OPTIONS);
}

export async function loadSession(): Promise<StoredSession> {
	const [serverUrl, refreshToken, orgId] = await Promise.all([
		read(KEYS.serverUrl),
		read(KEYS.refreshToken),
		read(KEYS.orgId),
	]);
	return { serverUrl, refreshToken, orgId };
}

export async function saveSession(session: Partial<StoredSession>): Promise<void> {
	const writes: Promise<void>[] = [];
	if (session.serverUrl !== undefined) writes.push(write(KEYS.serverUrl, session.serverUrl));
	if (session.refreshToken !== undefined) writes.push(write(KEYS.refreshToken, session.refreshToken));
	if (session.orgId !== undefined) writes.push(write(KEYS.orgId, session.orgId));
	await Promise.all(writes);
}

/** Sign-out: the token and the organization go, the address stays for next time. */
export async function clearSession(): Promise<void> {
	await saveSession({ refreshToken: null, orgId: null });
}
