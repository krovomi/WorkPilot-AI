/**
 * The account a project or a Kanban card pins for a provider with API-key
 * accounts (`shared/utils/ai-account-pins.ts`), applied to the environment the
 * credential manager built for that provider.
 *
 * The pin only names an id: the account is looked up here, in the main
 * store, and must belong to the provider the pin is for. Its key replaces the
 * one the credential manager chose (default account, API profile, main key)
 * and goes to the provider's own endpoint, so a base URL a profile named is
 * dropped, as for the default account (`ai-account-key.ts`). A pin to an
 * account that is gone or cannot be decrypted leaves the environment as it
 * was: the task runs on the provider's default, with a warning in the log.
 */

import { accountProviderOf } from "../../shared/types/ai-accounts";
import { appLog } from "../app-logger";
import {
	PROVIDER_BASE_URL_ENV_VARS,
	PROVIDER_KEY_ENV_VARS,
} from "../services/provider-settings-keys";
import { aiAccountStore } from "./ai-accounts";

/** The key of `accountId` when it is an account of `provider`, or undefined. */
export function pinnedAccountKey(
	provider: string,
	accountId: string | undefined,
): string | undefined {
	const accountProvider = accountProviderOf(provider);
	if (!accountProvider || !accountId) return undefined;
	try {
		const store = aiAccountStore();
		const account = store.get(accountId);
		if (account?.provider !== accountProvider) {
			appLog.warn(
				`[AiAccounts] pinned ${accountProvider} account not found, using the default one`,
			);
			return undefined;
		}
		const key = store.keyOf(accountId);
		if (!key) {
			appLog.warn(
				`[AiAccounts] pinned ${accountProvider} account has no readable key, using the default one`,
			);
		}
		return key;
	} catch (error) {
		appLog.warn("[AiAccounts] pinned account unreadable:", (error as Error).message);
		return undefined;
	}
}

/**
 * Puts the key of the pinned `accountId` into `env` for `provider`. Answers
 * whether it did; `env` is left untouched otherwise.
 */
export function applyPinnedAccount(
	env: Record<string, string>,
	provider: string,
	accountId: string | undefined,
): boolean {
	const accountProvider = accountProviderOf(provider);
	if (!accountProvider) return false;
	const keyVar = PROVIDER_KEY_ENV_VARS[accountProvider];
	const key = pinnedAccountKey(accountProvider, accountId);
	if (!key || !keyVar) return false;
	env[keyVar] = key;
	const baseUrlVar = PROVIDER_BASE_URL_ENV_VARS[accountProvider];
	if (baseUrlVar) delete env[baseUrlVar];
	// A pinned account is an API key: OpenAI's Codex sign-in would ignore it.
	if (accountProvider === "openai") env.OPENAI_AUTH_MODE = "api-key";
	return true;
}
