/**
 * The account a project works with on each forge, as the project settings
 * carry it (`ProjectEnvConfig.githubAccountId`…) and as its `.workpilot/.env`
 * stores it (`GITHUB_ACCOUNT_ID`…, `forge-credentials.ts`). An id is the only
 * thing the project file holds: the token stays in the account store.
 */

import type { ForgeKind } from "../../shared/types/forge-accounts";
import type { ProjectEnvConfig } from "../../shared/types/project";
import { forgeAccountStore } from "./forge-accounts";
import { FORGE_ACCOUNT_KEYS } from "./forge-credentials";

/** The settings fields naming an account, with their forge. */
export const FORGE_ACCOUNT_FIELDS = {
	githubAccountId: "github",
	gitlabAccountId: "gitlab",
	azureDevOpsAccountId: "azure_devops",
	bitbucketAccountId: "bitbucket",
} as const satisfies Partial<Record<keyof ProjectEnvConfig, ForgeKind>>;

type AccountField = keyof typeof FORGE_ACCOUNT_FIELDS;

function fields(): AccountField[] {
	return Object.keys(FORGE_ACCOUNT_FIELDS) as AccountField[];
}

/**
 * Why a settings update is refused, or null: an account it names must be one
 * saved for that forge ("" clears the choice). The renderer is not trusted.
 */
export function forgeAccountIdRefusal(config: Partial<ProjectEnvConfig>): string | null {
	for (const field of fields()) {
		const value: unknown = config[field];
		if (value === undefined || value === "") continue;
		if (typeof value !== "string") return `Invalid account (${field})`;
		if (forgeAccountStore().get(value)?.forge !== FORGE_ACCOUNT_FIELDS[field]) {
			return `Unknown account (${field})`;
		}
	}
	return null;
}

/** Writes the accounts an update names into the project's variables. */
export function applyForgeAccountIds(
	config: Partial<ProjectEnvConfig>,
	vars: Record<string, string>,
): void {
	for (const field of fields()) {
		const value = config[field];
		if (value !== undefined) vars[FORGE_ACCOUNT_KEYS[FORGE_ACCOUNT_FIELDS[field]]] = value;
	}
}

/** Reads the accounts the project's variables name into its settings. */
export function readForgeAccountIds(
	vars: Record<string, string>,
	config: Partial<ProjectEnvConfig>,
): void {
	for (const field of fields()) {
		const value = vars[FORGE_ACCOUNT_KEYS[FORGE_ACCOUNT_FIELDS[field]]]?.trim();
		if (value) config[field] = value;
	}
}
