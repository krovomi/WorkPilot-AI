import type { TFunction } from "i18next";
import type { MemoryJournalEntry } from "../../../../shared/types";

/** "by the coder agent", "by the sync"…: the actor of a journal entry. */
export function actorLabel(t: TFunction, actor: string): string {
	if (actor.startsWith("agent:")) {
		return t("context:lifecycle.actor.agentType", { type: actor.slice(6) });
	}
	return t(`context:lifecycle.actor.${actor}`, {
		defaultValue: t("context:lifecycle.actor.agent"),
	});
}

/** The translated sentence of one entry, without its date. */
export function entryLabel(t: TFunction, entry: MemoryJournalEntry): string {
	return t("context:lifecycle.entry", {
		action: t(`context:lifecycle.action.${entry.action}`),
		actor: actorLabel(t, entry.actor),
		reason: t(`context:lifecycle.reason.${entry.reason_code}`, {
			defaultValue: entry.reason_code,
		}),
	});
}

/** A backend refusal code, translated. */
export function errorLabel(t: TFunction, code: string | undefined): string {
	return t(`context:lifecycle.errors.${code ?? "failed"}`, {
		defaultValue: t("context:lifecycle.errors.failed"),
	});
}

/** A note's vault path, shortened to its place in the memory. */
export function shortPath(path: string): string {
	const index = path.indexOf("/memory/");
	return index >= 0 ? path.slice(index + "/memory/".length) : path;
}
