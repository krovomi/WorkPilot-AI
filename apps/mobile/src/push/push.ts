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
 * A finished spec whose plan waits for approval arrives as `plan_review`,
 * in the category of the same name: "Approve and build" and "View" buttons
 * (`PLAN_REVIEW_ACTIONS`). Approving asks for the phone's lock first
 * (`auth/lock.ts`; on iOS the device must also be unlocked), then calls the
 * same routes as the card's Start button.
 *
 * Nothing here is required: no EAS project id (a development build), no
 * permission, a simulator or the web, and the app just goes without.
 */

import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { Api } from "../api/endpoints";

export type PushKind = "run_finished" | "plan_review";

/** What the server puts in a notification's `data` (`server/services/push.py`). */
export interface PushCard {
	kind: PushKind;
	projectId: string;
	cardId: string;
	/** The card's id in the server's index, for its runs; absent from older servers. */
	specId: string | null;
}

/** The category the server names on a plan to approve, and its buttons. */
export const PLAN_REVIEW = "plan_review";
export const ACTION_APPROVE = "approve";
export const ACTION_VIEW = "view";

// A project or spec id is a uuid; a card id is its folder name ("012-add-login").
const ID = /^[A-Za-z0-9-]{1,64}$/;
const CARD_ID = /^\d{3,4}-[A-Za-z0-9._-]{1,200}$/;
const KINDS: ReadonlySet<unknown> = new Set<PushKind>(["run_finished", "plan_review"]);

let registered: string | null = null;

/** The card a notification opens, or null when its data is not one of ours. */
export function cardFromData(data: unknown): PushCard | null {
	if (!data || typeof data !== "object") return null;
	const { type, projectId, cardId, specId } = data as Record<string, unknown>;
	if (!KINDS.has(type)) return null;
	if (typeof projectId !== "string" || !ID.test(projectId)) return null;
	if (typeof cardId !== "string" || !CARD_ID.test(cardId)) return null;
	const spec = typeof specId === "string" && ID.test(specId) ? specId : null;
	return { kind: type as PushKind, projectId, cardId, specId: spec };
}

/**
 * Register the buttons of a plan to approve, in the app's language. Approving
 * opens the app, which asks for its lock; on iOS the device must be unlocked.
 */
export async function configureCategories(t: (key: string) => string): Promise<void> {
	if (!pushPlatform()) return;
	await Notifications.setNotificationCategoryAsync(PLAN_REVIEW, [
		{
			identifier: ACTION_APPROVE,
			buttonTitle: t("push.approve"),
			options: { opensAppToForeground: true, isAuthenticationRequired: true },
		},
		{ identifier: ACTION_VIEW, buttonTitle: t("push.view"), options: { opensAppToForeground: true } },
	]);
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
