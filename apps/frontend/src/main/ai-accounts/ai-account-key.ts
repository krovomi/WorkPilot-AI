/**
 * The key a provider runs on, for the credential manager: the default account
 * chosen in Settings → AI accounts (`ai-accounts.ts`) first, then the key
 * typed on the provider's own page. Read at each call, so a switch from the
 * header's popover reaches the next task, test or view without a restart.
 */

import { accountProviderOf } from "../../shared/types/ai-accounts";
import { appLog } from "../app-logger";
import { PROVIDER_SETTINGS_KEYS } from "../services/provider-settings-keys";
import { aiAccountStore } from "./ai-accounts";

/** The default account's key for `provider` (aliases included), or undefined. */
export function defaultAccountKey(provider: string | undefined | null): string | undefined {
	const accountProvider = accountProviderOf(provider);
	if (!accountProvider) return undefined;
	try {
		return aiAccountStore().defaultOf(accountProvider)?.apiKey;
	} catch (error) {
		// An unreadable store leaves the provider on its main key.
		appLog.warn("[AiAccounts] default account unreadable:", (error as Error).message);
		return undefined;
	}
}

/** The key typed on the provider's own page (Settings), or "". */
export function settingsApiKey(
	provider: string,
	settings: Readonly<Record<string, unknown>> | null | undefined,
): string {
	for (const field of PROVIDER_SETTINGS_KEYS[provider] ?? []) {
		const value = settings?.[field];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

/** Whether the provider's own page holds a key (the "main key"). */
export function hasMainKey(
	provider: string,
	settings: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
	return settingsApiKey(provider, settings) !== "";
}
