/**
 * AI accounts: several accounts of one AI provider (a personal OpenAI key, the
 * company's, a client's), saved once for the app, one of them the provider's
 * default (`main/ai-accounts/ai-accounts.ts`). The renderer only ever sees
 * whether an account has a key, never the key.
 *
 * Claude's accounts are its OAuth profiles (`ClaudeProfileManager`), which
 * already hold one sign-in each: the page lists them beside these.
 */

import { GATEWAY_PROVIDERS } from "../constants/gateway-providers";

/**
 * Providers whose accounts are API keys on the provider's own endpoint. AWS
 * (a key pair and a region), Windsurf, Cursor and the CLI providers sign in
 * another way and keep one account until they get their own store.
 */
export const AI_ACCOUNT_PROVIDERS: readonly string[] = [
	"openai",
	"google",
	"mistral",
	"deepseek",
	"grok",
	"meta",
	...GATEWAY_PROVIDERS.map((gateway) => gateway.id),
];

/** Aliases a task or a page may name for a provider of `AI_ACCOUNT_PROVIDERS`. */
const ACCOUNT_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
	gemini: "google",
};

/** The provider whose accounts `provider` uses, or undefined when it has none. */
export function accountProviderOf(provider: string | undefined | null): string | undefined {
	if (!provider) return undefined;
	const id = provider.trim().toLowerCase();
	const resolved = ACCOUNT_PROVIDER_ALIASES[id] ?? id;
	return AI_ACCOUNT_PROVIDERS.includes(resolved) ? resolved : undefined;
}

/** The key under which a pin names a Claude account (an OAuth profile id). */
export const CLAUDE_ACCOUNT_PROVIDER = "claude";

/**
 * Provider → account id a project or a Kanban card pins
 * (`shared/utils/ai-account-pins.ts`). The provider is one of
 * `AI_ACCOUNT_PROVIDERS` or `claude` (a profile id). Absent means the
 * provider's default account.
 */
export type AiAccountPins = Record<string, string>;

/** An account as the renderer sees it. */
export interface AiAccountView {
	id: string;
	provider: string;
	/** The name the person gave it ("Perso", "Client X"). */
	name: string;
	hasKey: boolean;
	createdAt: string;
	/** When the key got its current value. */
	keySetAt?: string;
}

/** The accounts and, per provider, the id of its default account. */
export interface AiAccountsSnapshot {
	accounts: AiAccountView[];
	/**
	 * Provider → default account id. A provider absent from it uses the key
	 * typed on its own page (the "main key"), when it has one.
	 */
	defaults: Record<string, string>;
	/** Providers whose own page holds a key (the main key). */
	mainKeys: string[];
}

/** What the renderer sends to create (no id) or update an account. */
export interface AiAccountInput {
	id?: string;
	provider: string;
	name: string;
	/** A new key; the mask or nothing keeps the saved one. */
	apiKey?: string;
}

export interface AiAccountTestResult {
	ok: boolean;
	/** Models the provider listed, when it says. */
	modelCount?: number;
	/** A short reason when `ok` is false (never the key, never the provider's raw body). */
	error?: string;
}
