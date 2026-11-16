/**
 * Every account's usage for the multi-profile view (getAllProfilesUsage), the
 * credentials the monitor reads, the OpenAI path through the backend, the
 * public controls (start, stop, provider switch, caches) and the logging
 * helpers — on a faked machine (usage-monitor-world.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
	"node:child_process",
	async () => (await import("./usage-monitor-world")).childProcessModule,
);
vi.mock("node:os", async () => ({
	...(await vi.importActual<typeof import("node:os")>("node:os")),
	homedir: () => "/home/tester",
}));
vi.mock(
	"../../claude-profile-manager",
	async () => (await import("./usage-monitor-world")).claudeProfileManagerModule,
);
vi.mock(
	"../../services/profile/profile-manager",
	async () => (await import("./usage-monitor-world")).profileFileModule,
);
vi.mock(
	"../../services/profile",
	async () => (await import("./usage-monitor-world")).profileFileModule,
);
vi.mock(
	"../../settings-utils",
	async () => (await import("./usage-monitor-world")).settingsModule,
);
vi.mock(
	"../credential-utils",
	async () => (await import("./usage-monitor-world")).credentialUtilsModule,
);
vi.mock(
	"../token-refresh",
	async () => (await import("./usage-monitor-world")).tokenRefreshModule,
);
vi.mock(
	"../../services/credential-manager",
	async () => (await import("./usage-monitor-world")).credentialManagerModule,
);
vi.mock("../codex-usage", async () =>
	(await import("./usage-monitor-world")).codexUsageModule(),
);
vi.mock(
	"../../env-utils",
	async () => (await import("./usage-monitor-world")).envUtilsModule,
);

import type { UsageSnapshot } from "@shared/types";
import {
	detectProvider,
	getUsageEndpoint,
	getUsageMonitor,
	UsageMonitor,
} from "../usage-monitor";
import { getVelocityTracker } from "../velocity-tracker";
import {
	answer,
	callsTo,
	type FakeClaudeProfile,
	fakeFetch,
	json,
	resetWorld,
	world,
} from "./usage-monitor-world";

const OAUTH_USAGE = "https://api.anthropic.com/api/oauth/usage";
const BACKEND = "http://localhost:9000/providers/usage";

const newMonitor = () =>
	new (UsageMonitor as unknown as new () => UsageMonitor)();

let monitor: UsageMonitor;
let errors: string[];
let warnings: string[];
const savedDebug = process.env.DEBUG;

function signIn(id: string, extra: Partial<FakeClaudeProfile> = {}) {
	const profile: FakeClaudeProfile = {
		id,
		name: `Account ${id}`,
		email: `${id}@example.com`,
		configDir: `/home/tester/.claude-${id}`,
		isAuthenticated: true,
		...extra,
	};
	world.claude.profiles.push(profile);
	if (profile.configDir) {
		world.keychain.set(profile.configDir, {
			token: `token-${id}`,
			email: profile.email ?? null,
		});
	}
	return profile;
}

function usageByToken(usage: Record<string, [number, number]>) {
	answer(OAUTH_USAGE, (call) => {
		const token = call.headers.authorization?.replace("Bearer token-", "") ?? "";
		const found = usage[token];
		if (!found) return json({}, 500);
		return json({
			five_hour: { utilization: found[0] },
			seven_day: { utilization: found[1] },
		});
	});
}

const internals = () =>
	monitor as unknown as {
		needsReauthProfiles: Set<string>;
		currentUsage: UsageSnapshot | null;
		currentUsageProfileId: string | null;
		apiResultCache: Map<string, unknown>;
		allProfilesUsageCache: Map<string, unknown>;
		rateLimitBackoff: Map<string, unknown>;
		apiFailureTimestamps: Map<string, number>;
	};

const snapshot = (profileId: string, extra: Partial<UsageSnapshot> = {}) =>
	({
		profileId,
		profileName: profileId,
		sessionPercent: 20,
		weeklyPercent: 30,
		fetchedAt: new Date("2026-11-15T09:00:00Z"),
		...extra,
	}) as UsageSnapshot;

beforeEach(() => {
	resetWorld();
	getVelocityTracker().clear();
	vi.stubGlobal("fetch", fakeFetch);
	errors = [];
	warnings = [];
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	});
	vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	});
	monitor = newMonitor();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.useRealTimers();
	if (savedDebug === undefined) delete process.env.DEBUG;
	else process.env.DEBUG = savedDebug;
});

describe("every account's usage", () => {
	it("before the first check, only says which accounts need signing in again", async () => {
		signIn("a");
		signIn("lost", { configDir: "~/.claude-lost" });
		world.keychain.delete("~/.claude-lost");
		signIn("fresh", { email: undefined, isAuthenticated: false });
		world.keychain.delete("/home/tester/.claude-fresh");
		signIn("nodir", { configDir: undefined, isAuthenticated: undefined });
		world.claude.activeProfileId = "a";

		const all = await monitor.getAllProfilesUsage();

		expect(all?.activeProfile).toMatchObject({
			profileId: "a",
			profileName: "Account a",
			needsReauthentication: false,
		});
		expect(
			all?.allProfiles.map((p) => [
				p.profileId,
				p.needsReauthentication,
				p.availabilityScore,
				p.isActive,
				p.isAuthenticated,
			]),
		).toEqual([
			["a", false, 100, true, true],
			["lost", true, 100, false, true],
			["fresh", false, 0, false, false],
			["nodir", false, 0, false, false],
		]);
		expect(world.fetchCalls).toEqual([]);
	});

	it("without an active account, still answers", async () => {
		const all = await monitor.getAllProfilesUsage();

		expect(all?.activeProfile).toMatchObject({ profileId: "", profileName: "" });
		expect(all?.allProfiles).toEqual([]);
	});

	it("shows the active account's last poll and fetches the others with their own token", async () => {
		signIn("a");
		signIn("b");
		signIn("c", { usage: { sessionUsagePercent: 44, weeklyUsagePercent: 55, lastUpdated: new Date("2026-11-14T00:00:00Z") } });
		signIn("off", { isAuthenticated: false });
		world.claude.activeProfileId = "a";
		internals().currentUsage = snapshot("a", { sessionPercent: 70, profileEmail: "polled@example.com" });
		internals().currentUsageProfileId = "a";
		usageByToken({ b: [10, 20] });

		const all = await monitor.getAllProfilesUsage();

		const byId = Object.fromEntries(all?.allProfiles.map((p) => [p.profileId, p]) ?? []);
		expect(byId.a).toMatchObject({ sessionPercent: 70, isActive: true, profileEmail: "polled@example.com" });
		expect(byId.b).toMatchObject({ sessionPercent: 10, weeklyPercent: 20, isActive: false });
		expect(byId.c).toMatchObject({ sessionPercent: 44, weeklyPercent: 55, lastFetchedAt: "2026-11-14T00:00:00.000Z" });
		expect(byId.off).toMatchObject({ sessionPercent: 0, weeklyPercent: 0 });
		expect(world.calls.batchUpdates).toEqual([
			{ profileId: "b", sessionPercent: 10, weeklyPercent: 20 },
		]);
		expect(getVelocityTracker().getVelocity("b").sampleCount).toBe(1);
		const scores = all?.allProfiles.map((p) => p.availabilityScore) ?? [];
		expect([...scores].sort((x, y) => y - x)).toEqual(scores);
	});

	it("reuses a minute-old result unless asked to refresh", async () => {
		signIn("a");
		signIn("b");
		world.claude.activeProfileId = "a";
		internals().currentUsage = snapshot("a");
		usageByToken({ b: [10, 20] });

		await monitor.getAllProfilesUsage();
		await monitor.getAllProfilesUsage();
		expect(callsTo(OAUTH_USAGE)).toHaveLength(1);

		internals().apiResultCache.clear();
		await monitor.getAllProfilesUsage(true);
		expect(callsTo(OAUTH_USAGE)).toHaveLength(2);
	});

	it("leaves no timer behind once the accounts are fetched", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		signIn("a");
		signIn("b");
		world.claude.activeProfileId = "a";
		internals().currentUsage = snapshot("a");
		usageByToken({ b: [10, 20] });

		await monitor.getAllProfilesUsage();

		expect(vi.getTimerCount()).toBe(0);
	});

	it("gives up after 30 seconds when an account never answers", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		signIn("a");
		signIn("b");
		world.claude.activeProfileId = "a";
		internals().currentUsage = snapshot("a");
		answer(OAUTH_USAGE, () => new Promise<Response>(() => undefined));

		const pending = monitor.getAllProfilesUsage();
		const settled = expect(pending).rejects.toThrow(
			"Usage fetch batch timed out after 30000ms",
		);
		await vi.advanceTimersByTimeAsync(30_000);
		await settled;
	});
});

describe("an inactive account's token", () => {
	beforeEach(() => {
		signIn("a");
		world.claude.activeProfileId = "a";
		internals().currentUsage = snapshot("a");
	});

	const usageOfB = async () =>
		(await monitor.getAllProfilesUsage(true))?.allProfiles.find(
			(p) => p.profileId === "b",
		);

	it("is refreshed when near expiry, clearing the re-auth flag", async () => {
		signIn("b", { configDir: "~/.claude-b" });
		// "~" is the home directory: the token is asked for the expanded path
		world.tokens.set("/home/tester/.claude-b", { token: "token-b", wasRefreshed: true });
		usageByToken({ b: [12, 13] });
		internals().needsReauthProfiles.add("b");

		expect(await usageOfB()).toMatchObject({ sessionPercent: 12, needsReauthentication: false });
	});

	it("reads the store when a refresh brings back no token", async () => {
		process.env.DEBUG = "true";
		monitor = newMonitor();
		signIn("a");
		world.claude.activeProfileId = "a";
		internals().currentUsage = snapshot("a");
		const b = signIn("b");
		world.tokens.set(b.configDir as string, { token: null, wasRefreshed: true });
		usageByToken({ b: [12, 13] });

		expect((await usageOfB())?.sessionPercent).toBe(12);
		expect(warnings.join("\n")).toContain("Proactively refreshed token for inactive profile: Account b");
	});

	it("flags a refresh that could not be saved", async () => {
		const b = signIn("b");
		world.tokens.set(b.configDir as string, {
			token: "token-b",
			wasRefreshed: true,
			persistenceFailed: true,
		});
		usageByToken({ b: [12, 13] });

		expect((await usageOfB())?.needsReauthentication).toBe(true);
		expect(warnings.join("\n")).toContain("persistence failed");
	});

	it("flags a revoked refresh token, then reads the store directly", async () => {
		const b = signIn("b");
		world.tokens.set(b.configDir as string, {
			token: null,
			wasRefreshed: false,
			error: "refresh failed",
			errorCode: "invalid_grant",
		});
		usageByToken({ b: [12, 13] });

		expect(await usageOfB()).toMatchObject({ sessionPercent: 12, needsReauthentication: true });
	});

	it("flags an account that lost its sign-in", async () => {
		const b = signIn("b");
		world.keychain.delete(b.configDir as string);

		expect(await usageOfB()).toMatchObject({ sessionPercent: 0, needsReauthentication: true });
	});

	it("keeps a stale token with an error flagged, and survives a refresh that throws", async () => {
		const b = signIn("b");
		world.tokens.set(b.configDir as string, {
			token: "token-b",
			wasRefreshed: false,
			error: "network",
			errorCode: "network_error",
		});
		usageByToken({ b: [12, 13] });
		internals().needsReauthProfiles.add("b");
		expect((await usageOfB())?.needsReauthentication).toBe(true);

		world.tokens.set(b.configDir as string, new Error("keychain locked"));
		internals().apiResultCache.clear();
		expect((await usageOfB())?.sessionPercent).toBe(12);
	});

	it("falls back to the saved usage when the API refuses it", async () => {
		signIn("b", { usage: { sessionUsagePercent: 33, weeklyUsagePercent: 44 } });
		answer(OAUTH_USAGE, json({}, 401));

		expect(await usageOfB()).toMatchObject({ sessionPercent: 33, weeklyPercent: 44 });
	});
});

describe("the active credential", () => {
	const credential = () => monitor["getCredential"]();

	it("is the active API profile's key first", async () => {
		world.apiFile.profiles = [
			{ id: "k", name: "Key", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-test-0000" },
			{ id: "nokey", name: "No key", baseUrl: "https://api.anthropic.com", apiKey: "" },
		];
		world.apiFile.activeProfileId = "k";
		expect(await credential()).toBe("sk-ant-test-0000");

		world.apiFile.activeProfileId = "nokey";
		expect(await credential()).toBeUndefined();
	});

	it("is the active Claude account's token otherwise, refreshed when needed", async () => {
		world.apiFileError = new Error("no profiles file");
		const a = signIn("a");
		world.claude.activeProfileId = "a";
		world.tokens.set(a.configDir as string, { token: "token-new", wasRefreshed: true });
		internals().needsReauthProfiles.add("a");

		expect(await credential()).toBe("token-new");
		expect(internals().needsReauthProfiles.has("a")).toBe(false);

		world.tokens.set(a.configDir as string, {
			token: "token-new",
			wasRefreshed: true,
			persistenceFailed: true,
		});
		expect(await credential()).toBe("token-new");
		expect(internals().needsReauthProfiles.has("a")).toBe(true);
	});

	it("falls back to the store when the refresh fails or throws", async () => {
		const a = signIn("a");
		world.claude.activeProfileId = "a";
		world.tokens.set(a.configDir as string, {
			token: null,
			wasRefreshed: false,
			error: "refresh failed",
			errorCode: "invalid_grant",
		});
		expect(await credential()).toBe("token-a");
		expect(internals().needsReauthProfiles.has("a")).toBe(true);

		world.tokens.set(a.configDir as string, new Error("keychain locked"));
		expect(await credential()).toBe("token-a");
		expect(errors.join("\n")).toContain("ensureValidToken threw error");
	});

	it("is missing when the store has none, flagging a lost sign-in", async () => {
		const a = signIn("a");
		world.claude.activeProfileId = "a";
		world.keychain.set(a.configDir as string, { token: null, email: null, error: "keychain locked" });
		expect(await credential()).toBeUndefined();
		expect(internals().needsReauthProfiles.has("a")).toBe(true);

		world.keychain.delete(a.configDir as string);
		world.tokens.set(a.configDir as string, { token: null, wasRefreshed: false });
		expect(await credential()).toBeUndefined();
	});

	it("is missing without any active profile", async () => {
		expect(await credential()).toBeUndefined();
	});
});

describe("a given account's credential", () => {
	const credentialOf = (profile: FakeClaudeProfile) =>
		monitor["getCredentialForProfile"](profile);

	it("needs a config dir", async () => {
		expect(await credentialOf({ id: "x", name: "X" })).toBeUndefined();
		expect(warnings.join("\n")).toContain("Profile has no configDir");
	});

	it("is refreshed, flagged when not saved, and read from the store as a last resort", async () => {
		const a = signIn("a");
		world.tokens.set(a.configDir as string, { token: "token-new", wasRefreshed: true });
		internals().needsReauthProfiles.add("a");
		expect(await credentialOf(a)).toBe("token-new");
		expect(internals().needsReauthProfiles.has("a")).toBe(false);

		world.tokens.set(a.configDir as string, {
			token: "token-new",
			wasRefreshed: true,
			persistenceFailed: true,
		});
		await credentialOf(a);
		expect(internals().needsReauthProfiles.has("a")).toBe(true);

		world.tokens.set(a.configDir as string, new Error("keychain locked"));
		expect(await credentialOf(a)).toBe("token-a");
		expect(errors.join("\n")).toContain("ensureValidToken threw");
	});

	it("reports a store that cannot be read and a lost sign-in", async () => {
		const a = signIn("a");
		world.keychain.set(a.configDir as string, { token: null, email: null, error: "keychain locked" });
		world.tokens.set(a.configDir as string, { token: null, wasRefreshed: false, error: "no token", errorCode: "missing_credentials" });

		expect(await credentialOf(a)).toBeUndefined();
		expect(internals().needsReauthProfiles.has("a")).toBe(true);
		expect(warnings.join("\n")).toContain("Keychain access failed");
	});
});

describe("OpenAI through the backend", () => {
	const check = () => monitor["checkUsageAndSwap"]();
	const usages: UsageSnapshot[] = [];

	beforeEach(() => {
		world.apiFile.profiles = [
			{ id: "oa", name: "OpenAI key", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test-0000" },
		];
		world.apiFile.activeProfileId = "oa";
		world.autoSwitch.enabled = false;
		world.cli = null;
		usages.length = 0;
		monitor.on("usage-updated", (u: UsageSnapshot) => usages.push(u));
	});

	it("turns the tokens used into a percent", async () => {
		answer(
			`${BACKEND}/openai`,
			json({
				usage: {
					total_tokens: 25_000,
					requests: 12,
					estimated_cost: 1.5,
					models: ["gpt-5"],
					organization_id: "org-1",
				},
				fetched_at: "2026-11-15T08:00:00.000Z",
			}),
		);

		await check();

		expect(usages[0]).toMatchObject({
			profileId: "oa",
			profileName: "OpenAI key",
			sessionPercent: 25,
			providerName: "openai",
			models: ["gpt-5"],
			organizationId: "org-1",
			openaiUsageDetails: { totalTokens: 25_000, requestsCount: 12, estimatedCost: 1.5 },
		});
	});

	it("caps the percent, and fills in what the backend leaves out", async () => {
		answer(`${BACKEND}/openai`, json({ usage: { total_tokens: 900_000 } }), json({ usage: {} }), json({}));

		await check();
		expect(usages[0]).toMatchObject({ sessionPercent: 100 });
		expect(usages[0]).not.toHaveProperty("models");
		await check();
		expect(usages[1].openaiUsageDetails).toMatchObject({ totalTokens: 0, requestsCount: 0, estimatedCost: 0 });
		await check();
		expect(usages[2]).toMatchObject({ sessionPercent: 0, providerName: "openai" });
	});

	it("passes on the backend's error and its alternative", async () => {
		answer(
			`${BACKEND}/openai`,
			json({ error: "USAGE_API_FORBIDDEN", message: "Admin key needed", alternative: "Use the dashboard" }),
			json({ error: "OTHER" }),
		);

		await check();
		expect(usages[0]).toMatchObject({
			error: "USAGE_API_FORBIDDEN",
			errorMessage: "Admin key needed",
			alternative: "Use the dashboard",
		});
		await check();
		expect(usages[1]).not.toHaveProperty("alternative");
	});

	it("retries a 429 after the delay the backend asks, then after a growing one", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		answer(
			`${BACKEND}/openai`,
			json({}, 429, { "retry-after": "2" }),
			json({}, 429),
			json({ usage: { total_tokens: 1000 } }),
		);

		const done = check();
		await vi.advanceTimersByTimeAsync(2000);
		expect(callsTo(BACKEND)).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1000);
		await done;

		expect(callsTo(BACKEND)).toHaveLength(3);
		expect(usages[0].sessionPercent).toBe(1);
	});

	it("stops after three 429s", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		answer(`${BACKEND}/openai`, json({}, 429));

		const done = check();
		await vi.advanceTimersByTimeAsync(5000);
		await done;

		expect(callsTo(BACKEND)).toHaveLength(3);
		expect(usages).toEqual([]);
	});

	it("says the backend is not started when nothing listens, and nothing on a timeout", async () => {
		await check();
		expect(usages[0]).toMatchObject({ error: "BACKEND_UNAVAILABLE", providerName: "openai" });

		answer(`${BACKEND}/openai`, Object.assign(new Error("aborted"), { name: "AbortError" }));
		internals().apiFailureTimestamps.clear();
		await check();
		answer(`${BACKEND}/openai`, new TypeError("bad response"));
		internals().apiFailureTimestamps.clear();
		internals().currentUsage = null;
		await check();
		expect(usages).toHaveLength(1);
	});
});

describe("the usage API's domain guard", () => {
	it("refuses an endpoint outside the allowed hosts", async () => {
		const usage = await monitor["fetchUsageViaAPI"](
			"sk-ant-test-0000",
			"k",
			"Console key",
			undefined,
			{
				profileId: "k",
				profileName: "Console key",
				isAPIProfile: true,
				baseUrl: "https://console.anthropic.com",
			},
		);

		expect(usage).toBeNull();
		expect(world.fetchCalls).toEqual([]);
		expect(errors.join("\n")).toContain("Blocked request to unauthorized domain");
	});
});

describe("the `claude usage` fallback", () => {
	const cli = () => monitor["fetchUsageViaCLI"]("a", "Account a");

	it("strips colours and reads a limit that was hit", async () => {
		world.cli = { stdout: "\x1b[31mYou've hit your limit\x1b[0m · resets 3pm", stderr: "", code: 0 };
		expect(await cli()).toMatchObject({ sessionPercent: 100, weeklyPercent: 0, limitType: "session" });
	});

	it("takes the first percents it finds in an unknown format", async () => {
		world.cli = { stdout: "usage: 12% now, 34% this week", stderr: "", code: null };
		expect(await cli()).toMatchObject({ sessionPercent: 12, weeklyPercent: 34, limitType: "weekly" });

		world.cli = { stdout: "usage: 12% now", stderr: "", code: 0 };
		expect(await cli()).toMatchObject({ sessionPercent: 12, weeklyPercent: 0 });

		world.cli = { stdout: "no numbers here", stderr: "", code: 0 };
		expect(await cli()).toMatchObject({ sessionPercent: 0, weeklyPercent: 0 });
	});

	it("gives nothing for a failed command, an empty output or a missing claude", async () => {
		world.cli = { stdout: "", stderr: "boom", code: 2 };
		expect(await cli()).toBeNull();
		world.cli = { stdout: "   \n", stderr: "", code: 0 };
		expect(await cli()).toBeNull();
		world.cli = null;
		expect(await cli()).toBeNull();
	});
});

describe("the public controls", () => {
	it("start checks after 10 seconds, then at the configured interval, once", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearInterval"] });
		world.autoSwitch.usageCheckInterval = 45_000;
		const spy = vi.spyOn(monitor as unknown as { checkUsageAndSwap: () => Promise<void> }, "checkUsageAndSwap").mockResolvedValue();

		monitor.start();
		monitor.start();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(spy.mock.calls).toEqual([[true]]);
		await vi.advanceTimersByTimeAsync(35_000);
		expect(spy.mock.calls).toEqual([[true], [false]]);

		monitor.stop();
		monitor.stop();
		await vi.advanceTimersByTimeAsync(90_000);
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("start defaults to a 60 second interval", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearInterval"] });
		const spy = vi.spyOn(monitor as unknown as { checkUsageAndSwap: () => Promise<void> }, "checkUsageAndSwap").mockResolvedValue();

		monitor.start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(spy).toHaveBeenCalledTimes(2);
		monitor.stop();
	});

	it("checkNow logs a check that throws", async () => {
		vi.spyOn(monitor as unknown as { checkUsageAndSwap: () => Promise<void> }, "checkUsageAndSwap").mockRejectedValue(new Error("boom"));

		monitor.checkNow();
		await new Promise((r) => setImmediate(r));

		expect(errors.join("\n")).toContain("Immediate check failed");
	});

	it("clearing an account's cache drops its usage everywhere", () => {
		getVelocityTracker().recordDataPoint("a", 10, 10);
		internals().allProfilesUsageCache.set("a", {});
		internals().currentUsage = snapshot("a");
		internals().currentUsageProfileId = "a";

		monitor.clearProfileUsageCache("b");
		expect(monitor.getCurrentUsage()).not.toBeNull();

		monitor.clearProfileUsageCache("a");
		expect(monitor.getCurrentUsage()).toBeNull();
		expect(internals().allProfilesUsageCache.has("a")).toBe(false);
		expect(getVelocityTracker().getVelocity("a").sampleCount).toBe(0);
	});

	it("clearing an auth failure lets the account be used again", () => {
		internals().needsReauthProfiles.add("a");
		(monitor as unknown as { authFailedProfiles: Map<string, number> }).authFailedProfiles.set("a", 1);

		monitor.clearAuthFailedProfile("a");
		monitor.clearAuthFailedProfile("never-failed");

		expect(internals().needsReauthProfiles.has("a")).toBe(false);
	});

	it("a provider switch clears every cache, a repeated request does not", () => {
		internals().currentUsage = snapshot("a");
		internals().apiResultCache.set("a", {});
		internals().rateLimitBackoff.set("a", {});
		getVelocityTracker().recordDataPoint("a", 10, 10);

		expect(monitor.onProviderRequestIfChanged("anthropic")).toBe(false);
		expect(monitor.onProviderRequestIfChanged("anthropic")).toBe(false);
		expect(internals().apiResultCache.size).toBe(1);

		expect(monitor.onProviderRequestIfChanged("openai")).toBe(true);
		expect(monitor.getCurrentUsage()).toBeNull();
		expect(internals().apiResultCache.size).toBe(0);
		expect(internals().rateLimitBackoff.size).toBe(0);
		expect(getVelocityTracker().getVelocity("a").sampleCount).toBe(0);
		expect(world.clearedKeychains).toEqual([undefined]);
	});

	it("there is one monitor for the app", () => {
		expect(getUsageMonitor()).toBe(getUsageMonitor());
	});
});

describe("debug logging", () => {
	it("prints the monitor's steps and the endpoint construction only with DEBUG=true", async () => {
		process.env.DEBUG = "true";
		// The lines are read as text: a terminal (or the pre-push hook's FORCE_COLOR)
		// would otherwise colour each segment and split "[UsageMonitor] Initialized".
		vi.stubEnv("NO_COLOR", "1");
		const debugMonitor = newMonitor();
		world.apiFile.profiles = [
			{ id: "local", name: "Ollama", baseUrl: "http://localhost:11434", apiKey: "x" },
		];
		answer(`${BACKEND}/copilot`, json({ available: true }));

		await debugMonitor.getUsageForProvider("ollama_local");
		await debugMonitor.getUsageForProvider("copilot");

		expect(getUsageEndpoint("anthropic", "https://api.anthropic.com/v1")).toBe(OAUTH_USAGE);
		expect(getUsageEndpoint("ollama", "https://ollama.ai")).toBeNull();
		expect(getUsageEndpoint("anthropic", "not a url")).toBeNull();
		expect(detectProvider("https://api.openai.com")).toBe("openai");
		expect(warnings.join("\n")).toContain("ENDPOINT_CONSTRUCTION");
		expect(warnings.join("\n")).toContain("PROVIDER_DETECTION");
		expect(errors.join("\n")).toContain("Invalid baseUrl for usage endpoint");
		expect(warnings.join("\n")).toContain("[UsageMonitor] Initialized");
	});
});
