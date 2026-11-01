/**
 * What the app does when the person taps a notification or one of its
 * buttons: open the card, or approve its plan and start the build first.
 *
 * Approving goes through the phone's lock (`ask`), then calls the routes the
 * card's Start button calls; the server checks the person's rights on both.
 */

import * as Notifications from "expo-notifications";
import type { Api } from "../api/endpoints";
import { ACTION_APPROVE, ACTION_VIEW, type PushCard } from "./push";

export type Response =
	| { kind: "open"; card: PushCard }
	| { kind: "approve"; card: PushCard }
	| { kind: "ignore" };

/** Which of our actions a tap means; anything else is ignored. */
export function responseAction(actionIdentifier: string, card: PushCard | null): Response {
	if (!card) return { kind: "ignore" };
	if (actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER || actionIdentifier === ACTION_VIEW) {
		return { kind: "open", card };
	}
	if (actionIdentifier === ACTION_APPROVE && card.kind === "plan_review") return { kind: "approve", card };
	return { kind: "ignore" };
}

/**
 * Approve the card's plan and start its build, once the person proved it is
 * them. False when they cancelled: nothing was sent.
 */
export async function approveAndBuild(api: Api, card: PushCard, ask: () => Promise<boolean>): Promise<boolean> {
	if (!(await ask())) return false;
	const specId =
		card.specId ?? (await api.cards(card.projectId)).find((c) => c.id === card.cardId)?.specId ?? null;
	if (!specId) throw new Error("card_not_indexed");
	await api.approve(card.projectId, card.cardId);
	await api.startRun(card.projectId, specId, "build");
	return true;
}
