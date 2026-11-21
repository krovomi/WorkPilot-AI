/**
 * The server's answer to an approval (server mode). A card may need several
 * people's approvals, by its criticality (`shared_board/approvals.py`): the
 * server records this person's and says whether the card now has them all.
 * Until it does, its build does not start, and the person is told how many
 * approvals it has, in the app's language, from the renderer's own texts
 * (`specApproval:server.waiting`).
 */

import en from "../shared/i18n/locales/en/specApproval.json";
import fr from "../shared/i18n/locales/fr/specApproval.json";
import type { IPCResult } from "../shared/types";
import { getAppLanguage } from "./app-language";

function wholeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
		? value
		: undefined;
}

/** Success when the card may be built; otherwise how many approvals it has. */
export function approvalOutcome(data: unknown, language = getAppLanguage()): IPCResult {
	const answer = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
	if (answer.approved === true) return { success: true };
	const approval =
		answer.approval && typeof answer.approval === "object"
			? (answer.approval as Record<string, unknown>)
			: {};
	const count = wholeNumber(approval.count) ?? 0;
	const needed = wholeNumber(approval.needed) ?? 1;
	const template = (language === "fr" ? fr : en).server.waiting;
	return {
		success: false,
		error: template.replace("{{count}}", String(count)).replace("{{needed}}", String(needed)),
	};
}
