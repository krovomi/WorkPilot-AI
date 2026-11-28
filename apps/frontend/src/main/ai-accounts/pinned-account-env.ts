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

import { accountProviderOf, loginProviderOf } from "../../shared/types/ai-accounts";
import { appLog } from "../app-logger";
import {
	PROVIDER_BASE_URL_ENV_VARS,
	PROVIDER_KEY_ENV_VARS,
} from "../services/provider-settings-keys";
import { aiAccountStore } from "./ai-accounts";
import { LOGIN_SPECS } from "./login-specs";

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

/**
 * Puts the folder of the pinned CLI sign-in account `accountId` into `env`
 * for `provider` (Copilot's GitHub CLI, Codex CLI for OpenAI, Gemini CLI),
 * in place of the default account's that the credential manager set. Only an
 * account of that CLI that is signed in counts; anything else leaves `env`
 * untouched, with a warning. For OpenAI, the task then runs in Codex mode.
 */
export function applyPinnedLoginAccount(
	env: Record<string, string>,
	provider: string,
	accountId: string | undefined,
): boolean {
	const loginProvider = loginProviderOf(provider);
	const spec = loginProvider ? LOGIN_SPECS[loginProvider] : undefined;
	if (!loginProvider || !spec || !accountId) return false;
	try {
		const store = aiAccountStore();
		const account = store.get(accountId);
		const home = store.homeOf(accountId);
		if (account?.provider !== loginProvider || !account.signedIn || !home) {
			appLog.warn(`[AiAccounts] pinned ${loginProvider} account not signed in, using the default one`);
			return false;
		}
		env[spec.backendEnv] = home;
		if (loginProvider === "codex") env.OPENAI_AUTH_MODE = "codex-cli";
		return true;
	} catch (error) {
		appLog.warn("[AiAccounts] pinned CLI account unreadable:", (error as Error).message);
		return false;
	}
}

/**
 * The API-key pins of `pins` that a process actually runs on: an account of
 * the provider it is pinned for, with a key. For the spend per account
 * (`account-attribution.ts`): a pin that fell back to the default is not
 * charged. Claude's pin is left out; its caller names the profile it used.
 */
export function servedAccountPins(
	pins: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
	const served: Record<string, string> = {};
	if (!pins) return served;
	try {
		const store = aiAccountStore();
		for (const [provider, id] of Object.entries(pins)) {
			const account = store.get(id);
			if (account?.hasKey && account.provider === accountProviderOf(provider)) served[provider] = id;
		}
	} catch (error) {
		appLog.warn("[AiAccounts] pinned accounts unreadable:", (error as Error).message);
	}
	return served;
}
