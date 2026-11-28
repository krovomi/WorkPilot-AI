/**
 * The variables a provider's default account adds to the backend's
 * environment when its key does not travel the usual way: AWS Bedrock's key
 * pair and region, and the key of Cursor and Windsurf, whose provider has no
 * branch of its own in the credential manager's key lookup. The other API-key
 * providers get their key from `defaultAccountKey` (`ai-account-key.ts`).
 */

import { accountProviderOf } from "../../shared/types/ai-accounts";
import { appLog } from "../app-logger";
import { aiAccountStore } from "./ai-accounts";

/** The variable each single-key provider of this module reads its key from. */
const KEY_ENV: Readonly<Record<string, string>> = {
	cursor: "CURSOR_API_KEY",
	windsurf: "WINDSURF_API_KEY",
};

/** What `provider`'s default account adds to the environment, or nothing. */
export function defaultAccountEnv(provider: string | undefined | null): Record<string, string> {
	const accountProvider = accountProviderOf(provider);
	if (accountProvider !== "aws" && !(accountProvider && KEY_ENV[accountProvider])) return {};
	try {
		const store = aiAccountStore();
		const chosen = store.defaultOf(accountProvider);
		if (!chosen) return {};
		if (accountProvider !== "aws") return { [KEY_ENV[accountProvider]]: chosen.apiKey };
		const pair = store.pairOf(chosen.account.id);
		if (!pair) return {};
		return {
			AWS_ACCESS_KEY_ID: chosen.apiKey,
			AWS_SECRET_ACCESS_KEY: pair.secretKey,
			AWS_DEFAULT_REGION: pair.region,
		};
	} catch (error) {
		// An unreadable store leaves the provider on what its own page holds.
		appLog.warn("[AiAccounts] default account unreadable:", (error as Error).message);
		return {};
	}
}
