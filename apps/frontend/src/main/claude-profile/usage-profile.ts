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
