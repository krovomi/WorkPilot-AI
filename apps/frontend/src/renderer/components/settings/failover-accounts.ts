/**
 * The accounts the failover chain can order, built from what the AI accounts
 * page knows is connected: Claude accounts, API profiles, the accounts of
 * Settings → AI accounts (several per provider), then every other connected
 * provider (Copilot, OpenAI, Mistral, Ollama, coding-agent CLIs...).
 * The ids are the ones the main reads (shared/utils/failover-chain.ts).
 */
import type { ClaudeProfile } from "@shared/types/agent";
import {
	type AiAccountView,
	engineProviderOfAccount,
	isAccountUsable,
} from "@shared/types/ai-accounts";
import type { APIProfile } from "@shared/types/profile";
import {
	apiProfileProvider,
	type FailoverEntryKind,
	failoverEntryId,
	isFailoverEntryExcluded,
	parseFailoverEntry,
} from "@shared/utils/failover-chain";

export interface FailoverAccount {
	readonly id: string;
	readonly kind: FailoverEntryKind;
	/** The provider the account runs on (its logo, its name). */
	readonly provider: string;
	/** The account's own name (profile name) or the provider's label. */
	readonly label: string;
	/** An email, an endpoint, a GitHub login: what tells two accounts apart. */
	readonly detail?: string;
	/** The account new Claude work uses now. */
	readonly isActive: boolean;
	readonly sessionPercent?: number;
	readonly weeklyPercent?: number;
}

export interface FailoverSources {
	readonly claudeProfiles: readonly ClaudeProfile[];
	readonly activeClaudeProfileId?: string | null;
	readonly apiProfiles: readonly APIProfile[];
	readonly activeApiProfileId?: string | null;
	/** Providers in display order, with their label. */
	readonly providers: ReadonlyArray<{ readonly name: string; readonly label: string }>;
	/** Which providers are connected (the page's own status). */
	readonly connected: Readonly<Record<string, boolean>>;
	/** Usage measured per Claude profile id. */
	readonly usage?: ReadonlyMap<string, { sessionPercent?: number; weeklyPercent?: number }>;
	readonly copilotLogin?: string;
	/** The accounts of Settings → AI accounts, and each provider's default. */
	readonly aiAccounts?: readonly AiAccountView[];
	readonly aiAccountDefaults?: Readonly<Record<string, string>>;
}

const CLAUDE = "anthropic";

/** Every account the chain can use, in a default order (Claude first). */
export function buildFailoverAccounts(sources: FailoverSources): FailoverAccount[] {
	const accounts: FailoverAccount[] = [];
	const covered = new Set<string>();

	for (const profile of sources.claudeProfiles) {
		if (!profile.isAuthenticated) continue;
		const usage = sources.usage?.get(profile.id);
		accounts.push({
			id: failoverEntryId("oauth", profile.id),
			kind: "oauth",
			provider: CLAUDE,
			label: profile.name,
			detail: profile.email,
			isActive: profile.id === sources.activeClaudeProfileId && !sources.activeApiProfileId,
			sessionPercent: usage?.sessionPercent,
			weeklyPercent: usage?.weeklyPercent,
		});
		covered.add(CLAUDE);
	}
	for (const profile of sources.apiProfiles) {
		if (!profile.apiKey) continue;
		const provider = apiProfileProvider(profile);
		accounts.push({
			id: failoverEntryId("api", profile.id),
			kind: "api",
			provider,
			label: profile.name,
			detail: profile.baseUrl,
			isActive: profile.id === sources.activeApiProfileId,
		});
		covered.add(provider);
	}
	// Several accounts of one provider: each is its own entry, and the
	// provider's generic entry would only repeat its default account. A Codex
	// sign-in runs OpenAI, whose generic entry stays: it is the OpenAI key.
	for (const account of sources.aiAccounts ?? []) {
		if (!isAccountUsable(account)) continue;
		const provider = engineProviderOfAccount(account.provider);
		accounts.push({
			id: failoverEntryId("account", account.id),
			kind: "account",
			provider,
			label: account.name,
			isActive: sources.aiAccountDefaults?.[account.provider] === account.id,
		});
		if (provider === account.provider) covered.add(provider);
	}
	for (const { name, label } of sources.providers) {
		if (!sources.connected[name] || covered.has(name)) continue;
		accounts.push({
			id: failoverEntryId("provider", name),
			kind: "provider",
			provider: name,
			label,
			detail: name === "copilot" && sources.copilotLogin ? `@${sources.copilotLogin}` : undefined,
			isActive: false,
		});
	}
	return accounts;
}

/**
 * The accounts in the saved order (an id from before the chain had kinds,
 * like `copilot`, still places its provider); accounts the order does not
 * name yet follow, in their default order.
 */
export function orderFailoverAccounts(
	accounts: readonly FailoverAccount[],
	savedOrder: readonly string[],
): FailoverAccount[] {
	const rank = new Map<string, number>();
	savedOrder.forEach((id, index) => {
		const entry = parseFailoverEntry(id);
		if (entry && !rank.has(entry.id)) rank.set(entry.id, index);
	});
	const position = (account: FailoverAccount) => rank.get(account.id) ?? Number.POSITIVE_INFINITY;
	return accounts
		.map((account, index) => ({ account, index }))
		.sort((a, b) => position(a.account) - position(b.account) || a.index - b.index)
		.map(({ account }) => account);
}

/** Whether the person took an account out of the chain (by id, or its provider for older lists). */
export function isAccountExcluded(account: FailoverAccount, excluded: readonly string[]): boolean {
	return isFailoverEntryExcluded({ id: account.id, kind: account.kind, key: account.provider }, excluded);
}
