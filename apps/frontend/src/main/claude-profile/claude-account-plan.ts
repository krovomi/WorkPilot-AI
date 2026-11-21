/**
 * The Claude plan an OAuth account has today, as Anthropic reports it.
 *
 * Claude Code records `subscriptionType` and `rateLimitTier` with its
 * credentials when it signs in, and WorkPilot copied them into its profile at
 * that moment. Neither copy is updated later: an account that moved from Pro
 * to Max kept showing "Pro" until its next login. The OAuth profile endpoint,
 * on the host the usage meter already calls with the same token, says what
 * the account has now.
 *
 * The token is read from the credentials store and sent only to that fixed
 * URL; it is never logged or returned. Only plan identifiers come back. When
 * the token is missing or expired, or the answer is not understood, nothing
 * is returned and the caller keeps the stored plan: nothing is guessed.
 */

import { getFullCredentialsFromKeychain } from "./credential-utils";

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const TIMEOUT_MS = 10_000;
/** The profile answer is a few hundred bytes; anything far larger is not it. */
const MAX_BODY_CHARS = 100_000;

export interface ClaudeAccountPlan {
	/** As Claude Code stores it: "max", "pro", "team", "enterprise"… */
	subscriptionType: string;
	/** e.g. "default_claude_max_20x"; absent when not reported. */
	rateLimitTier?: string;
}

/** `organization.organization_type` → the `subscriptionType` Claude Code stores. */
const ORGANIZATION_TYPES: Readonly<Record<string, string>> = {
	claude_max: "max",
	claude_pro: "pro",
	claude_team: "team",
	claude_enterprise: "enterprise",
};

const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;

function identifier(value: unknown): string | undefined {
	return typeof value === "string" && IDENTIFIER.test(value)
		? value
		: undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** The plan in an OAuth profile answer, or undefined when it names none. */
export function parseClaudeAccountPlan(
	body: unknown,
): ClaudeAccountPlan | undefined {
	const root = record(body);
	if (!root) return undefined;
	const organization = record(root.organization);
	const account = record(root.account);

	const orgType = identifier(organization?.organization_type)?.toLowerCase();
	let subscriptionType = orgType ? ORGANIZATION_TYPES[orgType] : undefined;
	if (!subscriptionType && account) {
		if (account.has_claude_max === true) subscriptionType = "max";
		else if (account.has_claude_pro === true) subscriptionType = "pro";
	}
	if (!subscriptionType) return undefined;

	const rateLimitTier = identifier(organization?.rate_limit_tier);
	return rateLimitTier ? { subscriptionType, rateLimitTier } : { subscriptionType };
}

/** Asks Anthropic which plan the account of this OAuth token has. */
export async function fetchClaudeAccountPlan(
	token: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ClaudeAccountPlan | undefined> {
	try {
		const response = await fetchImpl(PROFILE_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"anthropic-beta": "oauth-2025-04-20",
				"anthropic-version": "2023-06-01",
				"User-Agent": "claude-code/1.0.0",
			},
			redirect: "error",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!response.ok) return undefined;
		const text = await response.text();
		if (text.length > MAX_BODY_CHARS) return undefined;
		return parseClaudeAccountPlan(JSON.parse(text));
	} catch {
		return undefined;
	}
}

/**
 * The plan of the account signed in under this Claude config directory, or
 * undefined when its token is not usable (missing, expired) or Anthropic
 * does not say. Never refreshes a token: the usage meter owns that.
 */
export async function readClaudeAccountPlan(
	configDir: string | undefined,
	fetchImpl: typeof fetch = fetch,
): Promise<ClaudeAccountPlan | undefined> {
	let token: string | null;
	let expiresAt: number | null;
	try {
		({ token, expiresAt } = getFullCredentialsFromKeychain(configDir));
	} catch {
		return undefined;
	}
	if (!token) return undefined;
	if (expiresAt !== null && expiresAt <= Date.now()) return undefined;
	return fetchClaudeAccountPlan(token, fetchImpl);
}
