/**
 * Regression: the "re-authentication required" flag must clear as soon as the
 * profile's credential store holds a valid token again (e.g. after a new
 * `claude /login` into the profile's config dir), not only after a refresh.
 *
 * And it is a lost sign-in, not the absence of one: a profile never signed in
 * (the default "Primary" of a fresh install) has no credentials by design,
 * and must not raise "Reconnection required: the account expired" (F126).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureValidToken = vi.fn();

vi.mock("../token-refresh", () => ({
	ensureValidToken: (...args: unknown[]) => ensureValidToken(...args),
	reactiveTokenRefresh: vi.fn(),
}));

vi.mock("../credential-utils", () => ({
	getCredentialsFromKeychain: vi.fn(() => ({ token: null, email: null })),
	clearKeychainCache: vi.fn(),
}));

const settings: {
	activeProfileId: string;
	profiles: Array<Record<string, unknown>>;
} = { activeProfileId: "primary", profiles: [] };

vi.mock("../../claude-profile-manager", () => ({
	getClaudeProfileManager: vi.fn(() => ({
		getAutoSwitchSettings: vi.fn(() => ({ enabled: false })),
		getActiveProfile: vi.fn(),
		getSettings: vi.fn(() => settings),
	})),
}));

vi.mock("../../services/profile/profile-manager", () => ({
	loadProfilesFile: vi.fn(async () => ({ profiles: [], activeProfileId: null })),
}));

import { getUsageMonitor } from "../usage-monitor";

type MonitorInternals = {
	needsReauthProfiles: Set<string>;
	currentUsage: unknown;
	getCredentialForProfile(profile: {
		id: string;
		name: string;
		configDir?: string;
		email?: string;
	}): Promise<string | undefined>;
	getAllProfilesUsage(): Promise<{
		allProfiles: Array<{ profileId: string; needsReauthentication?: boolean }>;
	} | null>;
};

// Signed in once: login recorded the account's email.
const profile = {
	id: "primary",
	name: "Primary",
	configDir: "/home/u/.claude-profiles/primary",
	email: "user@example.com",
};

// The default profile of a fresh install: nobody ever signed in.
const neverSignedIn = {
	id: "primary",
	name: "Primary",
	configDir: "/home/u/.claude-profiles/primary",
};

describe("UsageMonitor re-auth flag", () => {
	let monitor: MonitorInternals;

	beforeEach(() => {
		ensureValidToken.mockReset();
		monitor = getUsageMonitor() as unknown as MonitorInternals;
		monitor.needsReauthProfiles.clear();
	});

	it("is set when the refresh token is rejected", async () => {
		ensureValidToken.mockResolvedValueOnce({
			token: null,
			wasRefreshed: false,
			error: "Token refresh failed: Refresh token expired",
			errorCode: "invalid_grant",
		});

		await monitor.getCredentialForProfile(profile);

		expect(monitor.needsReauthProfiles.has("primary")).toBe(true);
	});

	it("clears once a valid token is read without needing a refresh", async () => {
		monitor.needsReauthProfiles.add("primary");
		ensureValidToken.mockResolvedValueOnce({
			token: "fresh-token",
			wasRefreshed: false,
		});

		const token = await monitor.getCredentialForProfile(profile);

		expect(token).toBe("fresh-token");
		expect(monitor.needsReauthProfiles.has("primary")).toBe(false);
	});

	it("stays set when only a best-effort token is returned with an error", async () => {
		monitor.needsReauthProfiles.add("primary");
		ensureValidToken.mockResolvedValueOnce({
			token: "old-token",
			wasRefreshed: false,
			error: "Token refresh failed: network",
			errorCode: "network_error",
		});

		await monitor.getCredentialForProfile(profile);

		expect(monitor.needsReauthProfiles.has("primary")).toBe(true);
	});

	it("is set when a signed-in profile's credentials are gone", async () => {
		ensureValidToken.mockResolvedValueOnce({
			token: null,
			wasRefreshed: false,
			error: "No credentials found",
			errorCode: "missing_credentials",
		});

		await monitor.getCredentialForProfile(profile);

		expect(monitor.needsReauthProfiles.has("primary")).toBe(true);
	});

	it("is not set on a profile that was never signed in", async () => {
		ensureValidToken.mockResolvedValueOnce({
			token: null,
			wasRefreshed: false,
			error: "No credentials found",
			errorCode: "missing_credentials",
		});

		const token = await monitor.getCredentialForProfile(neverSignedIn);

		expect(token).toBeUndefined();
		expect(monitor.needsReauthProfiles.has("primary")).toBe(false);
	});

	it("is not set at start-up for the never-signed-in default profile", async () => {
		monitor.currentUsage = null;
		settings.profiles = [
			{ ...neverSignedIn, isDefault: true },
			{ ...profile, id: "work", name: "Work" },
		];

		const usage = await monitor.getAllProfilesUsage();

		const flags = Object.fromEntries(
			(usage?.allProfiles ?? []).map((p) => [p.profileId, p.needsReauthentication]),
		);
		expect(flags).toEqual({ primary: false, work: true });
	});
});
