/**
 * Which Claude account the usage badge of the Anthropic provider reads, and
 * what it shows when that account cannot be read.
 *
 * With several Claude accounts (Settings → AI accounts), the most available
 * account is not the one tasks run on: a fresh account with no usage yet sorts
 * first. The badge reads the active account, and only falls back to the most
 * available one when no account is active.
 */
import type { ClaudeProfile, UsageSnapshot } from "@shared/types";

interface ClaudeProfileSource {
	getActiveProfile(): ClaudeProfile | undefined;
	getProfilesSortedByAvailability(): ClaudeProfile[];
}

/** The active account, else the most available one, else none. */
export function usageProfileOf(manager: ClaudeProfileSource): ClaudeProfile | undefined {
	const profiles = manager.getProfilesSortedByAvailability();
	const activeId = manager.getActiveProfile()?.id;
	return profiles.find((profile) => profile.id === activeId) ?? profiles[0];
}

/**
 * The account has to sign in again (expired or revoked sign-in): the badge
 * says so and offers to reconnect, instead of "this provider publishes no
 * readable quota".
 */
export function reauthSnapshot(profile: Pick<ClaudeProfile, "id" | "name" | "email">): UsageSnapshot {
	return {
		sessionPercent: 0,
		weeklyPercent: 0,
		profileId: profile.id,
		profileName: profile.name,
		profileEmail: profile.email,
		providerName: "anthropic",
		fetchedAt: new Date(),
		needsReauthentication: true,
		usageUnmeasured: true,
	};
}

/** An HTTP refusal of the credentials: 401, 403, or a body that names them. */
export function isAuthFailure(error: unknown): boolean {
	if (!(error instanceof Error) || !("statusCode" in error)) return false;
	const { statusCode } = error as Error & { statusCode?: number };
	return statusCode === 401 || statusCode === 403 || error.message.includes("Auth Failure");
}

/** What the monitor lends to read one account's usage. */
export interface ClaudeUsageReader {
	/** The account's token, refreshed when needed; flags a lost sign-in. */
	credentialOf(profile: ClaudeProfile): Promise<string | undefined>;
	/** Its usage with that token (the API, then the CLI); throws on an auth failure. */
	fetchWith(profile: ClaudeProfile, credential: string): Promise<UsageSnapshot | null>;
	/** The accounts whose sign-in is lost. */
	needsReauth: Set<string>;
}

/**
 * The usage of the selected Claude account, or null when it cannot be read
 * now (the caller then falls back to the last reading).
 *
 * A lost sign-in says so in every case: no token left, a refresh refused, or
 * a token the usage API refuses (401/403). The latter used to escape as an
 * exception and end as "this provider publishes no readable quota", even for
 * an account whose expired token was still in the keyring.
 */
export async function readClaudeUsage(
	profile: ClaudeProfile,
	reader: ClaudeUsageReader,
): Promise<UsageSnapshot | null> {
	const credential = await reader.credentialOf(profile);
	if (!credential) {
		console.warn(
			"[UsageMonitor:getUsageForProvider] Step 2: No credential found for OAuth profile:",
			profile.name,
		);
	} else {
		try {
			const snapshot = await reader.fetchWith(profile, credential);
			// CLI-fetched snapshots lack providerName: always set it.
			if (snapshot) return { ...snapshot, providerName: snapshot.providerName || "anthropic" };
			console.warn(
				"[UsageMonitor:getUsageForProvider] Step 2: fetchUsage returned null for OAuth profile:",
				profile.name,
			);
		} catch (error) {
			if (!isAuthFailure(error)) throw error;
			reader.needsReauth.add(profile.id);
		}
	}
	return reader.needsReauth.has(profile.id) ? reauthSnapshot(profile) : null;
}
