/**
 * The coding-agent CLIs' accounts, as the rest of the main process uses
 * them: the folder variables the backend receives (the default account's, or
 * the one a card or a project pins), the folder Codex's usage is read from,
 * and the sign-in terminal of an account.
 */

import { type AiAccountSignIn, loginProviderOf } from "../../shared/types/ai-accounts";
import { appLog } from "../app-logger";
import { aiAccountStore } from "./ai-accounts";
import { LOGIN_SPECS } from "./login-specs";

/** The folder of `provider`'s default CLI account, or undefined (the system's sign-in). */
export function defaultLoginHome(provider: string): string | undefined {
	try {
		return aiAccountStore().defaultHomeOf(provider);
	} catch (error) {
		appLog.warn("[ai-accounts] could not read the default CLI account:", (error as Error).message);
		return undefined;
	}
}

/**
 * The folder variable of each CLI that has a default account, for the
 * backend's environment; empty when none has one (each CLI then reads its
 * usual folder).
 */
export function loginAccountEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [provider, spec] of Object.entries(LOGIN_SPECS)) {
		const home = defaultLoginHome(provider);
		if (home) env[spec.backendEnv] = home;
	}
	return env;
}

/**
 * The folder of `accountId` when it is a signed-in account of the CLI
 * `loginProvider`, or undefined: a pin to an account that is gone, of another
 * CLI or signed out leaves the task on the CLI's default, with a warning.
 */
export function pinnedLoginHome(loginProvider: string, accountId: string | undefined): string | undefined {
	if (!accountId) return undefined;
	try {
		const store = aiAccountStore();
		const account = store.get(accountId);
		if (account?.provider !== loginProvider || !account.signedIn) {
			appLog.warn(`[ai-accounts] pinned ${loginProvider} account not signed in, using the default one`);
			return undefined;
		}
		return store.homeOf(accountId);
	} catch (error) {
		appLog.warn("[ai-accounts] pinned CLI account unreadable:", (error as Error).message);
		return undefined;
	}
}

/**
 * Points `provider`'s CLI at the folder of the pinned sign-in `accountId`
 * (`openai` → Codex CLI, which then runs on that ChatGPT plan rather than an
 * API key). Answers whether it did; `env` is left untouched otherwise.
 */
export function applyPinnedLogin(
	env: Record<string, string>,
	provider: string,
	accountId: string | undefined,
): boolean {
	const loginProvider = loginProviderOf(provider);
	if (!loginProvider) return false;
	const home = pinnedLoginHome(loginProvider, accountId);
	if (!home) return false;
	env[LOGIN_SPECS[loginProvider].backendEnv] = home;
	if (loginProvider === "codex") env.OPENAI_AUTH_MODE = "codex-cli";
	return true;
}

/** What the sign-in terminal of the CLI account `id` runs, or undefined. */
export function signInPlanOf(id: string): AiAccountSignIn | undefined {
	const store = aiAccountStore();
	const account = store.get(id);
	const spec = account && LOGIN_SPECS[account.provider];
	const home = store.homeOf(id);
	if (!account || !spec || !home) return undefined;
	return {
		terminalId: `ai-account-login-${account.provider}-${Date.now()}`,
		command: spec.command,
		env: { [spec.cliEnv]: home },
	};
}

/**
 * Whether a terminal may take `key=dir` from the renderer: the folder
 * variable of a CLI and the folder of one of that CLI's accounts, as
 * `signInPlanOf` handed it out.
 */
export function isSignInEnv(key: string, dir: unknown): boolean {
	if (typeof dir !== "string") return false;
	const provider = Object.keys(LOGIN_SPECS).find((name) => LOGIN_SPECS[name].cliEnv === key);
	if (!provider) return false;
	try {
		return aiAccountStore().isLoginHome(provider, dir);
	} catch {
		return false;
	}
}
