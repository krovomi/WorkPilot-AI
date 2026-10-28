/**
 * Regression: the "re-authentication required" flag must clear as soon as the
 * profile's credential store holds a valid token again (e.g. after a new
 * `claude /login` into the profile's config dir), not only after a refresh.
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

vi.mock("../../claude-profile-manager", () => ({
	getClaudeProfileManager: vi.fn(() => ({
		getAutoSwitchSettings: vi.fn(() => ({ enabled: false })),
		getActiveProfile: vi.fn(),
	})),
}));

vi.mock("../../services/profile/profile-manager", () => ({
	loadProfilesFile: vi.fn(async () => ({ profiles: [], activeProfileId: null })),
}));

import { getUsageMonitor } from "../usage-monitor";

type MonitorInternals = {
	needsReauthProfiles: Set<string>;
	getCredentialForProfile(profile: {
		id: string;
		name: string;
		configDir?: string;
	}): Promise<string | undefined>;
};

const profile = {
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
});
