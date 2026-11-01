/**
 * The theme between the phone and the person's account on the server
 * (`/users/me/preferences`), so it follows them from device to device.
 *
 * At sign-in: a choice still waiting to be sent (made offline) goes to the
 * server first, but only when the person signed in is the one who made it;
 * otherwise the server's choice, when it has one, wins over the phone's
 * copy; a server with none receives the phone's copy if it is this person's.
 * A copy left by someone else (another account on the same phone) is never
 * sent: its pending flag is dropped and the server's choice, or nothing,
 * wins. A change in Settings is applied and kept locally at once, then
 * sent; a failed send leaves it pending for the next sync, and never
 * reaches the UI as an error.
 */

import type { ThemePrefs } from "./theme-ids";
import { parsePrefs } from "./theme-ids";
import type { StoredPrefs } from "./theme-store";

export interface PrefsApi {
	preferences(): Promise<unknown>;
	setPreferences(prefs: ThemePrefs): Promise<unknown>;
}

/** Send a choice; whether it is still pending afterwards. */
export async function pushPrefs(api: PrefsApi, prefs: ThemePrefs): Promise<boolean> {
	try {
		await api.setPreferences({ theme: prefs.theme, colorTheme: prefs.colorTheme });
		return false;
	} catch {
		return true;
	}
}

/**
 * Reconcile the phone's copy with the account of `userId`, who is signed
 * in; the preferences to apply and keep, or null to keep the copy as it is.
 */
export async function syncPrefs(
	api: PrefsApi,
	local: StoredPrefs | null,
	userId: string,
): Promise<StoredPrefs | null> {
	const mine = local !== null && local.owner === userId;
	if (local?.pending && mine) {
		const pending = await pushPrefs(api, local);
		return pending ? null : { ...local, pending: false };
	}
	// Someone else's choice waiting on this phone: never sent to this account.
	const dropped = local?.pending ? { ...local, pending: false } : null;
	let remote: ThemePrefs | null;
	try {
		remote = parsePrefs(await api.preferences());
	} catch {
		// Offline, or a server without the route: the phone's copy stands.
		return dropped;
	}
	if (remote) {
		const same = mine && local.theme === remote.theme && local.colorTheme === remote.colorTheme;
		return same ? null : { ...remote, pending: false, owner: userId };
	}
	if (mine) await pushPrefs(api, local);
	return dropped;
}
