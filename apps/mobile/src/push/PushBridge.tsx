/**
 * Mounted once under the signed-in stack: registers this phone for the
 * person (again when the language changes, so the server writes in it) and
 * opens the card of a notification the person taps, including the one that
 * launched the app.
 */

import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { useSession } from "../auth/session";
import { cardFromData, configureForeground, registerForPush } from "./push";

configureForeground();

export function PushBridge() {
	if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
	return <NativePushBridge />;
}

function NativePushBridge() {
	const { api, user } = useSession();
	const { i18n } = useTranslation();
	const router = useRouter();
	const response = Notifications.useLastNotificationResponse();
	const handled = useRef<string | null>(null);

	useEffect(() => {
		if (!api || !user) return;
		registerForPush(api, i18n.language).catch(() => {
			// No token (no Firebase file, no network): the app works without.
		});
	}, [api, user, i18n.language]);

	useEffect(() => {
		if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
		const id = response.notification.request.identifier;
		if (handled.current === id) return;
		handled.current = id;
		const card = cardFromData(response.notification.request.content.data);
		if (!card) return;
		router.push({
			pathname: "/projects/[projectId]/cards/[cardId]",
			params: { projectId: card.projectId, cardId: card.cardId },
		});
		void Notifications.clearLastNotificationResponseAsync();
	}, [response, router]);

	return null;
}
