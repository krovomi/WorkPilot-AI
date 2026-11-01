/**
 * Notifications from the server: a run you started finished.
 *
 * After sign-in the phone asks for permission, gets its Expo push token and
 * registers it with the server (`PUT /users/me/devices`), with the app's
 * language so the text arrives in it. On sign-out the token is unregistered
 * first, while the session can still call the server. The server sends only
 * the project's name, the card's number, the phase and its result; tapping
 * the notification opens the card from its `data`.
 *
 * Nothing here is required: no EAS project id (a development build), no
 * permission, a simulator or the web, and the app just goes without.
 */

import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { Api } from "../api/endpoints";

/** What the server puts in a notification's `data` (`server/services/push.py`). */
export interface RunFinishedData {
	projectId: string;
	cardId: string;
}

// A project id is a uuid; a card id is its folder name ("012-add-login").
const PROJECT_ID = /^[A-Za-z0-9-]{1,64}$/;
const CARD_ID = /^\d{3,4}-[A-Za-z0-9._-]{1,200}$/;

let registered: string | null = null;

/** The card a notification opens, or null when its data is not one of ours. */
export function cardFromData(data: unknown): RunFinishedData | null {
	if (!data || typeof data !== "object") return null;
	const { type, projectId, cardId } = data as Record<string, unknown>;
	if (type !== "run_finished") return null;
	if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) return null;
	if (typeof cardId !== "string" || !CARD_ID.test(cardId)) return null;
	return { projectId, cardId };
}

export function easProjectId(): string | null {
	const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
	const id = extra?.eas?.projectId ?? Constants.easConfig?.projectId;
	return typeof id === "string" && id ? id : null;
}

function pushPlatform(): "ios" | "android" | null {
	return Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : null;
}

/** Show a notification that arrives while the app is open, as a banner. */
export function configureForeground(): void {
	if (!pushPlatform()) return;
	Notifications.setNotificationHandler({
		handleNotification: async () => ({
			shouldShowBanner: true,
			shouldShowList: true,
			shouldPlaySound: false,
			shouldSetBadge: false,
		}),
	});
}

/**
 * Register this phone for the signed-in person; returns the token, or null
 * when notifications are not available here or were refused.
 */
export async function registerForPush(api: Api, locale: string): Promise<string | null> {
	const platform = pushPlatform();
	const projectId = easProjectId();
	if (!platform || !projectId || !Device.isDevice) return null;
	if (platform === "android") {
		await Notifications.setNotificationChannelAsync("runs", {
			name: "Runs",
			importance: Notifications.AndroidImportance.DEFAULT,
		});
	}
	let { status } = await Notifications.getPermissionsAsync();
	if (status !== "granted") {
		({ status } = await Notifications.requestPermissionsAsync());
	}
	if (status !== "granted") return null;
	const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
	await api.registerDevice(token, platform, locale);
	registered = token;
	return token;
}

/** Forget this phone on the server; never blocks a sign-out. */
export async function unregisterFromPush(api: Api | null): Promise<void> {
	const token = registered;
	registered = null;
	if (!token || !api) return;
	try {
		await api.unregisterDevice(token);
	} catch {
		// The server forgets it anyway once Expo reports it gone.
	}
}
