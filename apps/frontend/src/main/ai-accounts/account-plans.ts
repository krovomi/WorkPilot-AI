/**
 * Every saved account of a provider with its plan, for a feature that turns
 * itself on for some plans (Claude Ship on a Team or Enterprise organization)
 * and for display. Never a token or a key: an id, a name, a plan, whether it
 * is the default.
 *
 * Claude: its OAuth profiles, with the `subscriptionType` the profile manager
 * keeps (asked live to Anthropic by `claude-account-plan.ts`, then stored).
 * API-key providers: the accounts of `ai-accounts.ts`, on the "api" plan.
 */

import { accountProviderOf } from "../../shared/types/ai-accounts";
import { getClaudeProfileManager } from "../claude-profile-manager";
import { aiAccountStore } from "./ai-accounts";

export type AccountPlan = "team" | "enterprise" | "max" | "pro" | "api" | "unknown";

export interface AccountWithPlan {
	id: string;
	provider: string;
	name: string;
	plan: AccountPlan;
	isDefault: boolean;
	/** Whether the account can run now (Claude: signed in; API: a key is saved). */
	signedIn: boolean;
}

const CLAUDE_PLANS: Readonly<Record<string, AccountPlan>> = {
	team: "team",
	enterprise: "enterprise",
	max: "max",
	pro: "pro",
};

/** A Claude `subscriptionType` as one of the plans above. */
export function claudePlanOf(subscriptionType: unknown): AccountPlan {
	if (typeof subscriptionType !== "string") return "unknown";
	return CLAUDE_PLANS[subscriptionType.trim().toLowerCase()] ?? "unknown";
}

/** The accounts of `provider` with their plan; empty for a provider without accounts. */
export function accountsWithPlan(provider: string): AccountWithPlan[] {
	const id = provider.trim().toLowerCase();
	if (id === "anthropic" || id === "claude") {
		const { profiles, activeProfileId } = getClaudeProfileManager().getSettings();
		return profiles.map((profile) => ({
			id: profile.id,
			provider: "anthropic",
			name: profile.name,
			plan: claudePlanOf(profile.subscriptionType),
			isDefault: profile.id === activeProfileId,
			signedIn: profile.isAuthenticated !== false,
		}));
	}
	const accountProvider = accountProviderOf(id);
	if (!accountProvider) return [];
	const store = aiAccountStore();
	const defaultId = store.defaults()[accountProvider];
	return store
		.list()
		.filter((account) => account.provider === accountProvider)
		.map((account) => ({
			id: account.id,
			provider: accountProvider,
			name: account.name,
			plan: "api",
			isDefault: account.id === defaultId,
			signedIn: account.hasKey,
		}));
}

/** Whether a signed-in Claude account is on a Team or Enterprise organization. */
export function hasClaudeOrganizationPlan(): boolean {
	return accountsWithPlan("anthropic").some(
		(account) => account.signedIn && (account.plan === "team" || account.plan === "enterprise"),
	);
}
