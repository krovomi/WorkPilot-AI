/**
 * Claude profiles as the renderer may see them (rule S6): the OAuth token is
 * masked, so the UI learns that a profile has one, never the token. A profile
 * saved back with the mask keeps its stored token.
 */
import type { ClaudeProfile, ClaudeProfileSettings } from "../../shared/types";
import { maskSecret, unmaskSecret } from "../utils/masked-secret";

export function maskClaudeProfile<T extends ClaudeProfile | null | undefined>(
	profile: T,
): T {
	if (!profile) return profile;
	return { ...profile, oauthToken: maskSecret(profile.oauthToken) };
}

export function maskClaudeProfileSettings(
	settings: ClaudeProfileSettings,
): ClaudeProfileSettings {
	return {
		...settings,
		profiles: settings.profiles.map((profile) => maskClaudeProfile(profile)),
	};
}

/** `profile` from the renderer, its token taken from `stored` when masked. */
export function unmaskClaudeProfile(
	profile: ClaudeProfile,
	stored: ClaudeProfile | undefined,
): ClaudeProfile {
	const typed = unmaskSecret(profile.oauthToken);
	return {
		...profile,
		oauthToken: typed === undefined ? stored?.oauthToken : typed,
	};
}
