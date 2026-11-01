/**
 * Mounted once under the signed-in stack: registers this phone for the
 * person (again when the language changes, so the server writes in it, and
 * the buttons of a plan to approve with it) and acts on a notification the
 * person taps, including the one that launched the app: open its card, or
 * approve its plan and build (`respond.ts`), then open the card.
 */

import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Platform } from "react-native";
import { confirmSensitive } from "../auth/lock";
import { useSession } from "../auth/session";
import { describeError } from "../i18n";
import { cardFromData, configureCategories, configureForeground, registerForPush } from "./push";
import { approveAndBuild, responseAction } from "./respond";

configureForeground();

export function PushBridge() {
	if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
	return <NativePushBridge />;
}

function NativePushBridge() {
	const { api, user } = useSession();
	const { t, i18n } = useTranslation();
	const router = useRouter();
	const response = Notifications.useLastNotificationResponse();
	const handled = useRef<string | null>(null);

	useEffect(() => {
		if (!api || !user) return;
		registerForPush(api, i18n.language).catch(() => {
			// No token (no Firebase file, no network): the app works without.
		});
		configureCategories((key) => t(key)).catch(() => {
			// Without buttons, a tap still opens the card.
		});
	}, [api, user, i18n.language, t]);

	useEffect(() => {
		if (!response || !api) return;
		const id = `${response.notification.request.identifier}:${response.actionIdentifier}`;
		if (handled.current === id) return;
		const action = responseAction(
			response.actionIdentifier,
			cardFromData(response.notification.request.content.data),
		);
		if (action.kind === "ignore") return;
		handled.current = id;
		void Notifications.clearLastNotificationResponseAsync();
		const { card } = action;
		const open = () =>
			router.push({
				pathname: "/projects/[projectId]/cards/[cardId]",
				params: { projectId: card.projectId, cardId: card.cardId },
			});
		if (action.kind === "open") {
			open();
			return;
		}
		approveAndBuild(api, card, () => confirmSensitive(t("lock.approvePrompt"), t("common.cancel")))
			.catch((err: unknown) => Alert.alert(t("push.approveFailed"), describeError(err)))
			.finally(open);
	}, [response, api, router, t]);

	return null;
}
