/**
 * The coding-agent CLIs' default accounts, as the rest of the main process
 * uses them: the folder variables the backend receives, the folder Codex's
 * usage is read from, and the sign-in terminal of an account.
 */

import type { AiAccountSignIn } from "../../shared/types/ai-accounts";
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
