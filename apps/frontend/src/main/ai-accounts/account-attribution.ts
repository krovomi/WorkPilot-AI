/**
 * Which AI account an agent process runs on, told to the backend so each
 * session's spend is recorded against it (`foundation/ai_account.py` writes
 * the id beside the session in `.workpilot/cost_data.json`).
 *
 * `WORKPILOT_AI_ACCOUNTS` is a JSON object from provider to account key: the
 * default account of each API-key provider that has one with a key (the one
 * `ai-account-key.ts` hands to the process), the default signed-in account of
 * each coding-agent CLI (`login-accounts.ts`), and `claude:<profile>` for the
 * Claude sign-in the process got. Ids only, never a key: they are opaque
 * labels the app made (`randomUUID`, a profile's slug).
 *
 * A process whose provider takes another key (a profile of `profiles.json`,
 * the main key) gets no entry for it, so its spend stays unattributed rather
 * than charged to the wrong account.
 */

import { AI_ACCOUNT_KEY_PATTERN, claudeAccountKey } from "../../shared/types/ai-account-usage";
import { appLog } from "../app-logger";
import { aiAccountStore } from "./ai-accounts";

export const AI_ACCOUNTS_ENV = "WORKPILOT_AI_ACCOUNTS";

/**
 * Provider → account key for the process about to start. `usesClaude` false
 * (a task with no Claude phase, whose Claude sign-in is cleared) names no
 * Claude account. `pins` are the accounts a task or its project chose over
 * the defaults (provider → account id; `claude` → profile id): a caller that
 * runs the process on a pinned account passes them, so its spend goes there.
 */
export function processAccounts(
	claudeProfileId?: string | null,
	usesClaude = true,
	pins: Readonly<Record<string, string>> = {},
): Record<string, string> {
	const accounts: Record<string, string> = {};
	try {
		const store = aiAccountStore();
		// A key account runs once it has a key, a CLI sign-in once it is signed in.
		const usable = new Set(
			store
				.list()
				.filter((a) => a.hasKey || a.signedIn === true)
				.map((a) => a.id),
		);
		for (const [provider, id] of Object.entries(store.defaults())) {
			if (usable.has(id) && AI_ACCOUNT_KEY_PATTERN.test(id)) accounts[provider] = id;
		}
	} catch (error) {
		// An unreadable store leaves the spend unattributed, never the task unstarted.
		appLog.warn("[AiAccounts] accounts of the process unreadable:", (error as Error).message);
	}
	for (const [provider, id] of Object.entries(pins)) {
		if (provider !== "claude" && AI_ACCOUNT_KEY_PATTERN.test(id)) accounts[provider] = id;
	}
	const claudeProfile = pins.claude ?? claudeProfileId;
	if (claudeProfile && usesClaude) {
		const key = claudeAccountKey(claudeProfile);
		if (AI_ACCOUNT_KEY_PATTERN.test(key)) accounts.claude = key;
	}
	return accounts;
}

/** The environment variable naming them, or nothing when there is none. */
export function processAccountsEnv(
	claudeProfileId?: string | null,
	usesClaude = true,
	pins: Readonly<Record<string, string>> = {},
): Record<string, string> {
	const accounts = processAccounts(claudeProfileId, usesClaude, pins);
	return Object.keys(accounts).length > 0 ? { [AI_ACCOUNTS_ENV]: JSON.stringify(accounts) } : {};
}
