/**
 * Lends a saved forge account's credentials to the readers of a project's
 * forge settings.
 *
 * A project names the account it works with in its `.workpilot/.env`
 * (`GITHUB_ACCOUNT_ID`, `GITLAB_ACCOUNT_ID`, `AZURE_DEVOPS_ACCOUNT_ID`,
 * `BITBUCKET_ACCOUNT_ID`); the token itself stays in the app's account store
 * (`forge-accounts.ts`). The forge readers (GitHub, GitLab, Azure DevOps and
 * Bitbucket configs, PR creation, CI pipelines, the agent's environment) read
 * the project's variables through `withForgeAccounts`, which puts the
 * account's token in place of the project's own, with the address the token
 * was saved for: a GitLab account sets the instance URL, an Azure DevOps one
 * the organization URL, so a token never goes to another host.
 *
 * Never applied in `readProjectEnvFile` itself: the settings page reads and
 * writes the project file through it, and would save the account's token
 * into the project.
 *
 * A project that names an account which no longer exists, or one of another
 * forge, gets no token for that forge rather than another credential.
 */

import {
	FORGE_KINDS,
	type ForgeAccountView,
	type ForgeKind,
} from "../../shared/types/forge-accounts";
import { type ProjectLocation, readProjectEnv } from "../project-env-file";
import { type ForgeAccountStore, forgeAccountStore } from "./forge-accounts";

/** The project variable naming each forge's account. */
export const FORGE_ACCOUNT_KEYS: Readonly<Record<ForgeKind, string>> = {
	github: "GITHUB_ACCOUNT_ID",
	gitlab: "GITLAB_ACCOUNT_ID",
	azure_devops: "AZURE_DEVOPS_ACCOUNT_ID",
	bitbucket: "BITBUCKET_ACCOUNT_ID",
};

type Vars = Record<string, string>;

/** What an account sets in the project's variables (token "" when none). */
const LEND: Readonly<
	Record<ForgeKind, (vars: Vars, account: ForgeAccountView | undefined, token: string) => void>
> = {
	github: (vars, _account, token) => {
		vars.GITHUB_TOKEN = token;
	},
	gitlab: (vars, account, token) => {
		if (account) vars.GITLAB_INSTANCE_URL = account.host;
		vars.GITLAB_TOKEN = token;
	},
	azure_devops: (vars, account, token) => {
		if (account) vars.AZURE_DEVOPS_ORG_URL = account.host;
		vars.AZURE_DEVOPS_PAT = token;
	},
	bitbucket: (vars, account, token) => {
		vars.BITBUCKET_USERNAME = account?.username ?? "";
		vars.BITBUCKET_TOKEN = token;
	},
};

/** The account id a project names for `forge`, or "" when it names none. */
export function projectForgeAccountId(vars: Vars, forge: ForgeKind): string {
	return (vars[FORGE_ACCOUNT_KEYS[forge]] ?? "").trim();
}

/**
 * `vars` with the credentials of the accounts they name (a copy; `vars`
 * itself is never changed). Unchanged when they name no account, without
 * reading the account store.
 */
export function withForgeAccounts(vars: Vars, store?: ForgeAccountStore): Vars {
	const named = FORGE_KINDS.filter((forge) => projectForgeAccountId(vars, forge));
	if (named.length === 0) return vars;
	const accounts = store ?? forgeAccountStore();
	const lent: Vars = { ...vars };
	for (const forge of named) {
		const id = projectForgeAccountId(vars, forge);
		const found = accounts.get(id);
		const account = found?.forge === forge ? found : undefined;
		LEND[forge](lent, account, (account && accounts.tokenOf(id)) || "");
	}
	return lent;
}

/** A project's `.env`, decrypted, with the credentials of its accounts. */
export function readProjectForgeEnv(project: ProjectLocation): Vars {
	return withForgeAccounts(readProjectEnv(project));
}
