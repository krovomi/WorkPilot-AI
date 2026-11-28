/**
 * The periodic usage check (checkUsageAndSwap): which profile is active, how
 * its usage is fetched (API, cache, backoff, CLI), what is emitted, and when
 * the monitor swaps Claude accounts before a limit — on a faked machine
 * (usage-monitor-world.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
	"node:child_process",
	async () => (await import("./usage-monitor-world")).childProcessModule,
);
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
import { getOperationRegistry } from "../operation-registry";
import { getProfileSelectionLock } from "../profile-selection-lock";
import { UsageMonitor } from "../usage-monitor";
import { getVelocityTracker } from "../velocity-tracker";
import {
	answer,
	callsTo,
	type FakeClaudeProfile,
	fakeFetch,
	json,
	profileManager,
	resetWorld,
	text,
	tokenRefreshModule,
	world,
} from "./usage-monitor-world";

const OAUTH_USAGE = "https://api.anthropic.com/api/oauth/usage";
const BACKEND = "http://127.0.0.1:9000/providers/usage";
const T0 = new Date("2026-11-15T10:00:00.000Z").getTime();

const newMonitor = () =>
	new (UsageMonitor as unknown as new () => UsageMonitor)();

let monitor: UsageMonitor;
let errors: string[];
let events: Array<[string, unknown]>;

/** A Claude account signed in, its token in its config dir's store. */
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

/** The OAuth usage API, answering each token with its own utilization. */
function usageByToken(usage: Record<string, [number, number]>) {
	answer(OAUTH_USAGE, (call) => {
		const token = call.headers.authorization?.replace("Bearer ", "") ?? "";
		const found = usage[token.replace("token-", "")];
		if (!found) return json({ error: { type: "not_found_error" } }, 404);
		return json({
			five_hour: { utilization: found[0], resets_at: "2026-11-15T12:00:00Z" },
			seven_day: { utilization: found[1], resets_at: "2026-11-20T00:00:00Z" },
		});
	});
}

const check = (suppress = false) => monitor["checkUsageAndSwap"](suppress);
const emitted = (name: string) =>
	events.filter(([n]) => n === name).map(([, v]) => v);
const lastUsage = () => emitted("usage-updated").at(-1) as UsageSnapshot;

beforeEach(() => {
	resetWorld();
	getVelocityTracker().clear();
	getProfileSelectionLock().clear();
	getOperationRegistry().clear();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
	vi.stubGlobal("fetch", fakeFetch);
	errors = [];
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	});
	monitor = newMonitor();
	events = [];
	for (const name of [
		"usage-updated",
		"all-profiles-usage-updated",
		"proactive-swap-completed",
		"proactive-swap-failed",
		"show-swap-notification",
		"proactive-operations-restarted",
	]) {
		monitor.on(name, (value) => events.push([name, value]));
	}
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("the active Claude account", () => {
	beforeEach(() => {
		signIn("a");
		signIn("b");
		world.claude.activeProfileId = "a";
		world.autoSwitch.enabled = false;
	});

	it("is measured, remembered, emitted and saved", async () => {
		usageByToken({ a: [30, 40], b: [10, 20] });

		await check();

		expect(monitor.getCurrentUsage()).toMatchObject({
			profileId: "a",
			profileName: "Account a",
			profileEmail: "a@example.com",
			sessionPercent: 30,
			weeklyPercent: 40,
			providerName: "anthropic",
			needsReauthentication: false,
		});
		expect(lastUsage()).toBe(monitor.getCurrentUsage());
		expect(world.calls.updateUsage).toEqual([["a", 30, 40]]);
		expect(world.calls.clearRateLimitEvents).toEqual(["a"]);
		const all = emitted("all-profiles-usage-updated")[0] as {
			allProfiles: Array<{ profileId: string; sessionPercent: number }>;
		};
		expect(all.allProfiles.map((p) => [p.profileId, p.sessionPercent])).toEqual([
			["b", 10],
			["a", 30],
		]);
		expect(world.calls.batchUpdates).toEqual([
			{ profileId: "b", sessionPercent: 10, weeklyPercent: 20 },
		]);
		expect(getVelocityTracker().getVelocity("a").sampleCount).toBe(1);
	});

	it("keeps rate limit events while usage is high", async () => {
		usageByToken({ a: [92, 40] });

		await check();

		expect(world.calls.clearRateLimitEvents).toEqual([]);
	});

	it("runs one check at a time", async () => {
		world.claude.profiles = world.claude.profiles.slice(0, 1);
		usageByToken({ a: [30, 40] });

		await Promise.all([check(), check()]);

		expect(callsTo(OAUTH_USAGE)).toHaveLength(1);
	});

	it("reads the email from the credential store when the profile has none", async () => {
		world.claude.profiles = [];
		signIn("c", { email: undefined });
		world.keychain.set("/home/tester/.claude-c", {
			token: "token-c",
			email: "c@keychain.example",
		});
		world.claude.activeProfileId = "c";
		usageByToken({ c: [1, 2] });

		await check();

		expect(lastUsage().profileEmail).toBe("c@keychain.example");
	});

	it("asks the CLI when the account has no token", async () => {
		world.keychain.clear();
		world.cli = { stdout: "Current session 7% used\nCurrent week (all models) 9% used", stderr: "", code: 0 };

		await check();

		expect(callsTo(OAUTH_USAGE)).toHaveLength(0);
		// In the account's own folder, not the default ~/.claude
		expect(world.spawns).toEqual([{ command: "claude", args: ["usage"], configDir: "/home/tester/.claude-a" }]);
		expect(lastUsage()).toMatchObject({
			sessionPercent: 7,
			weeklyPercent: 9,
			providerName: "anthropic",
		});
	});

	it("emits nothing when no usage can be read", async () => {
		usageByToken({});
		world.cli = null;

		await check();

		expect(events).toEqual([]);
		expect(monitor.getCurrentUsage()).toBeNull();
	});

	it("does nothing without any active profile", async () => {
		world.claude.activeProfileId = null;

		await check();

		expect(world.fetchCalls).toEqual([]);
		expect(events).toEqual([]);
	});

	it("logs a check that fails for another reason than authentication", async () => {
		vi.spyOn(profileManager, "getActiveProfile").mockImplementation(() => {
			throw new Error("profiles store busy");
		});

		await check();

		expect(errors.join("\n")).toContain("Check failed");
	});
});

describe("fetching from the usage API", () => {
	beforeEach(() => {
		signIn("a");
		world.claude.activeProfileId = "a";
		world.autoSwitch.enabled = false;
	});

	it("reuses a result younger than 15 seconds", async () => {
		usageByToken({ a: [30, 40] });

		await check();
		vi.setSystemTime(T0 + 10_000);
		await check();
		expect(callsTo(OAUTH_USAGE)).toHaveLength(1);

		vi.setSystemTime(T0 + 16_000);
		await check();
		expect(callsTo(OAUTH_USAGE)).toHaveLength(2);
	});

	it("backs off after a 429, doubling the wait, and shows the last result meanwhile", async () => {
		const ok = json({ five_hour: { utilization: 30 }, seven_day: { utilization: 40 } });
		answer(OAUTH_USAGE, ok, json({}, 429), json({}, 429), ok);

		await check();
		vi.setSystemTime(T0 + 20_000);
		await check(); // 429: the stale result is kept
		expect(lastUsage().sessionPercent).toBe(30);
		expect(world.spawns).toHaveLength(0);

		vi.setSystemTime(T0 + 60_000);
		await check(); // within the 5 min backoff: no request
		expect(callsTo(OAUTH_USAGE)).toHaveLength(2);
		expect(lastUsage().sessionPercent).toBe(30);

		vi.setSystemTime(T0 + 20_000 + 5 * 60_000);
		await check(); // second 429: the backoff becomes 10 min
		vi.setSystemTime(T0 + 20_000 + 5 * 60_000 + 9 * 60_000);
		await check();
		expect(callsTo(OAUTH_USAGE)).toHaveLength(3);

		vi.setSystemTime(T0 + 20_000 + 5 * 60_000 + 10 * 60_000);
		await check();
		expect(callsTo(OAUTH_USAGE)).toHaveLength(4);
	});

	it("falls back to the CLI on a 429 without any result, then shows that usage during the backoff", async () => {
		answer(OAUTH_USAGE, json({}, 429));
		world.cli = { stdout: "Current session 11% used", stderr: "", code: 0 };

		await check();
		expect(lastUsage().sessionPercent).toBe(11);
		expect(world.spawns).toHaveLength(1);

		vi.setSystemTime(T0 + 30_000);
		world.cli = null;
		await check();
		expect(world.spawns).toHaveLength(1);
		expect(lastUsage().sessionPercent).toBe(11);
	});

	it("waits two minutes before trying the API again after a failure", async () => {
		answer(OAUTH_USAGE, json({ error: "overloaded" }, 529), text("<html>busy</html>", 502), new Error("ECONNRESET"));
		world.cli = { stdout: "Current session 5% used", stderr: "", code: 0 };

		await check();
		vi.setSystemTime(T0 + 60_000);
		await check();
		expect(callsTo(OAUTH_USAGE)).toHaveLength(1);
		expect(errors.join("\n")).toContain("API error: 529");

		vi.setSystemTime(T0 + 2 * 60_000);
		await check(true); // startup check: the error is not logged
		expect(callsTo(OAUTH_USAGE)).toHaveLength(2);
		expect(errors.filter((e) => e.includes("API error: 502"))).toEqual([]);

		vi.setSystemTime(T0 + 4 * 60_000);
		await check();
		expect(errors.join("\n")).toContain("API fetch failed");
		// The CLI answered every failed request; during the wait its last usage was shown
		expect(world.spawns).toHaveLength(3);
	});

	it("reads an older answer format and the per-model buckets of a Pro plan", async () => {
		answer(
			OAUTH_USAGE,
			json({ five_hour_utilization: 0.255, seven_day_utilization: 0.5, five_hour_reset_at: "r1", seven_day_reset_at: "r2" }),
			json({
				five_hour: { utilization: 59, resets_at: "r3" },
				seven_day: null,
				seven_day_opus: null,
				seven_day_sonnet: { utilization: 70, resets_at: "r4" },
				seven_day_omelette: { utilization: 90, resets_at: null },
				seven_day_cowork: { utilization: 20, resets_at: "r5" },
				seven_day_flag: true,
			}),
			json({ five_hour: { utilization: 10 }, seven_day: null }),
			json({}),
		);

		await check();
		expect(lastUsage()).toMatchObject({
			sessionPercent: 26,
			weeklyPercent: 50,
			sessionResetTimestamp: "r1",
			weeklyResetTimestamp: "r2",
			limitType: "weekly",
		});
		for (const expected of [
			{ sessionPercent: 59, weeklyPercent: 70, weeklyResetTimestamp: "r4" },
			{ sessionPercent: 10, weeklyPercent: -1, limitType: "session" },
			{ sessionPercent: 0, weeklyPercent: 0 },
		]) {
			vi.setSystemTime(Date.now() + 16_000);
			await check();
			expect(lastUsage()).toMatchObject(expected);
		}
	});
});

describe("an authentication failure", () => {
	let a: FakeClaudeProfile;

	beforeEach(() => {
		a = signIn("a");
		signIn("b");
		world.claude.activeProfileId = "a";
	});

	it("is retried with a refreshed token, without swapping", async () => {
		usageByToken({});
		answer(OAUTH_USAGE, json({}, 401));
		world.reactive.set(a.configDir as string, { token: "token-new", wasRefreshed: true });
		monitor["needsReauthProfiles"].add("a");

		await check();

		expect(monitor["needsReauthProfiles"].has("a")).toBe(false);
		expect(emitted("proactive-swap-completed")).toEqual([]);
		expect(monitor["authFailedProfiles"].has("a")).toBe(false);
	});

	it("flags a refresh that could not be saved", async () => {
		answer(OAUTH_USAGE, json({}, 403));
		world.reactive.set(a.configDir as string, {
			token: "token-new",
			wasRefreshed: true,
			persistenceFailed: true,
		});

		await check();

		expect(monitor["needsReauthProfiles"].has("a")).toBe(true);
	});

	it("swaps to another account when the refresh token is revoked", async () => {
		answer(OAUTH_USAGE, json({}, 401));
		world.reactive.set(a.configDir as string, {
			token: null,
			wasRefreshed: false,
			error: "invalid_grant",
			errorCode: "invalid_grant",
		});

		await check();

		expect(monitor["needsReauthProfiles"].has("a")).toBe(true);
		expect(world.clearedKeychains).toContain(a.configDir);
		expect(monitor["authFailedProfiles"].has("a")).toBe(true);
		expect(world.calls.setActiveProfile).toEqual(["b"]);
		expect(emitted("show-swap-notification")).toEqual([
			{ fromProfile: "Account a", toProfile: "Account b", reason: "proactive", limitType: "session" },
		]);
	});

	it("is read in an error body that names the credentials", async () => {
		answer(OAUTH_USAGE, json({ error: { message: "Invalid token provided" } }, 400));
		world.reactive.set(a.configDir as string, new Error("refresh endpoint down"));

		await check();

		expect(errors.join("\n")).toContain("Token refresh threw error");
		expect(world.calls.setActiveProfile).toEqual(["b"]);
	});

	it("reports that every other account failed too", async () => {
		answer(OAUTH_USAGE, json({}, 401));
		world.reactive.set(a.configDir as string, { token: null, wasRefreshed: false });
		monitor["authFailedProfiles"].set("b", Date.now());
		monitor["authFailedProfiles"].set("old", Date.now() - 6 * 60_000);

		await check();

		expect(monitor["authFailedProfiles"].has("old")).toBe(false);
		expect(emitted("proactive-swap-failed")).toEqual([
			{
				reason: "all_alternatives_failed_auth",
				currentProfile: "a",
				excludedProfiles: ["a", "b"],
			},
		]);
	});

	it("does not swap when swapping is off, and needs a config dir to refresh", async () => {
		answer(OAUTH_USAGE, json({}, 401));
		world.autoSwitch.proactiveSwapEnabled = false;
		a.configDir = undefined;
		world.keychain.set("/nowhere", { token: null, email: null });
		vi.spyOn(profileManager, "getActiveProfile").mockReturnValue({
			...a,
			configDir: "/home/tester/.claude-a",
		});

		await check();

		expect(tokenRefreshModule.reactiveTokenRefresh).not.toHaveBeenCalledWith(undefined);
		expect(monitor["authFailedProfiles"].has("a")).toBe(true);
		expect(world.calls.setActiveProfile).toEqual([]);
	});

	it("logs a swap that throws", async () => {
		answer(OAUTH_USAGE, json({}, 401));
		vi.spyOn(profileManager, "getAccountPriorityOrder").mockImplementation(() => {
			throw new Error("order unreadable");
		});

		await check();

		expect(errors.join("\n")).toContain("Failed to perform auth-failure swap");
	});
});

describe("a proactive swap", () => {
	beforeEach(() => {
		signIn("a");
		signIn("b");
		world.claude.activeProfileId = "a";
	});

	it("moves to the next account once the session passes its threshold", async () => {
		usageByToken({ a: [96, 10], b: [5, 5] });
		monitor["allProfilesUsageCache"].set("a", { usage: {} as never, fetchedAt: Date.now() });

		await check();

		expect(world.calls.setActiveProfile).toEqual(["b"]);
		expect(emitted("proactive-swap-completed")[0]).toMatchObject({
			fromProfile: { id: "a", name: "Account a" },
			toProfile: { id: "b", name: "Account b" },
			limitType: "session",
		});
		expect(getProfileSelectionLock().isLocked("b")).toBe(false);
	});

	it("holds to 95 % and 99 % when the settings name no threshold", async () => {
		usageByToken({ a: [96, 10], b: [5, 5] });
		world.autoSwitch.sessionThreshold = undefined as never;
		world.autoSwitch.weeklyThreshold = undefined as never;

		await check();

		expect(emitted("proactive-swap-completed")[0]).toMatchObject({ limitType: "session" });
	});

	it("names the week when the weekly threshold is passed", async () => {
		usageByToken({ a: [10, 99], b: [5, 5] });

		await check();

		expect(emitted("show-swap-notification")[0]).toMatchObject({ limitType: "weekly" });
	});

	it("does not happen when switching is off", async () => {
		usageByToken({ a: [100, 100], b: [5, 5] });
		world.autoSwitch.enabled = false;
		await check();
		world.autoSwitch.enabled = true;
		world.autoSwitch.proactiveSwapEnabled = false;
		vi.setSystemTime(T0 + 16_000);
		await check();

		expect(world.calls.setActiveProfile).toEqual([]);
	});

	it("waits two minutes before the next one", async () => {
		usageByToken({ a: [96, 10], b: [97, 10] });

		await check();
		vi.setSystemTime(T0 + 60_000);
		await check();
		expect(world.calls.setActiveProfile).toEqual(["b"]);
	});

	it("is suppressed when it would close a loop", async () => {
		usageByToken({ a: [96, 10], b: [5, 5] });
		monitor["recentSwapChain"] = [
			{ from: "a", to: "b", at: Date.now() - 60_000 },
			{ from: "b", to: "a", at: Date.now() - 30_000 },
		];

		await check();

		expect(world.calls.setActiveProfile).toEqual([]);
	});

	it("tells loops apart from a chain of different accounts", () => {
		const loop = (chain: Array<[string, string, number]>, current: string) => {
			monitor["recentSwapChain"] = chain.map(([from, to, ago]) => ({
				from,
				to,
				at: Date.now() - ago,
			}));
			return monitor["detectSwapLoop"](current);
		};
		expect(loop([["a", "b", 1000]], "b")).toBe(false);
		expect(loop([["a", "b", 2000], ["a", "c", 1000]], "d")).toBe(true);
		expect(loop([["a", "b", 2000], ["c", "d", 1000]], "e")).toBe(false);
		expect(loop([["a", "b", 11 * 60_000], ["b", "a", 1000]], "a")).toBe(false);
	});

	it("follows the account priority order, API profiles included", async () => {
		usageByToken({ a: [96, 10], b: [5, 5] });
		world.apiFile.profiles = [
			{ id: "k", name: "Key", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-test-0000" },
			{ id: "nokey", name: "No key", baseUrl: "https://api.anthropic.com", apiKey: "" },
		];
		world.priorityOrder = ["api-k", "oauth-b"];

		await check();

		expect(world.apiActivations).toEqual(["k"]);
		expect(world.calls.setActiveProfile).toEqual([]);
		expect(emitted("proactive-swap-completed")[0]).toMatchObject({
			toProfile: { id: "k", name: "Key" },
		});
	});

	it("puts Claude accounts first without a priority order", async () => {
		usageByToken({ a: [96, 10], b: [5, 5] });
		world.apiFile.profiles = [
			{ id: "k", name: "Key", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-test-0000" },
			{ id: "k2", name: "Key 2", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-test-1111" },
		];

		await check();

		expect(world.calls.setActiveProfile).toEqual(["b"]);
	});

	it("gives up when the API profile cannot be activated", async () => {
		usageByToken({ a: [96, 10] });
		world.claude.profiles = world.claude.profiles.slice(0, 1);
		world.apiFile.profiles = [
			{ id: "k", name: "Key", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-test-0000" },
		];
		world.apiActivationError = new Error("profiles.json is read-only");

		await check();

		expect(errors.join("\n")).toContain("Failed to set active API profile");
		expect(getProfileSelectionLock().isLocked("k")).toBe(false);
		expect(emitted("proactive-swap-completed")).toEqual([]);
	});

	it("takes the next account when the best one is locked, and skips when all are", async () => {
		signIn("c");
		usageByToken({ a: [96, 10], b: [5, 5], c: [6, 6] });
		const lock = getProfileSelectionLock();
		lock.tryAcquire("b", "another swap");

		await check();
		expect(world.calls.setActiveProfile).toEqual(["c"]);

		world.claude.activeProfileId = "a";
		monitor["lastProactiveSwapAt"] = 0;
		monitor["recentSwapChain"] = [];
		lock.tryAcquire("c", "another swap");
		vi.setSystemTime(T0 + 16_000);
		await check();
		expect(world.calls.setActiveProfile).toEqual(["c"]);
	});

	it("reports no alternative, even when the API profiles cannot be read", async () => {
		world.claude.profiles = world.claude.profiles.slice(0, 1);
		usageByToken({ a: [96, 10] });
		world.apiFileError = new Error("profiles.json is corrupt");

		await check();

		expect(emitted("proactive-swap-failed")).toEqual([
			{ reason: "no_alternative", currentProfile: "a", excludedProfiles: ["a"] },
		]);
	});

	it("restarts the operations that ran on the old account", async () => {
		usageByToken({ a: [96, 10], b: [5, 5] });
		const restartedWith: string[] = [];
		getOperationRegistry().registerOperation(
			"task-1",
			"spec-creation",
			"a",
			"Account a",
			async (profileId) => {
				restartedWith.push(profileId);
				return true;
			},
		);

		await check();

		expect(restartedWith).toEqual(["b"]);
		expect(emitted("proactive-operations-restarted")[0]).toMatchObject({
			operationIds: ["task-1"],
			restartedCount: 1,
			limitType: "session",
		});
	});

	it("happens early when the usage climbs fast toward the session limit", async () => {
		usageByToken({ a: [90, 10], b: [5, 5] });
		const tracker = getVelocityTracker();
		vi.setSystemTime(T0 - 2 * 60_000);
		tracker.recordDataPoint("a", 50, 10);
		vi.setSystemTime(T0 - 60_000);
		tracker.recordDataPoint("a", 70, 10);
		vi.setSystemTime(T0);

		await check();

		expect(emitted("proactive-swap-completed")[0]).toMatchObject({ limitType: "session" });
	});

	it("happens early when the week runs out within half an hour", async () => {
		usageByToken({ a: [10, 80], b: [5, 5] });
		const tracker = getVelocityTracker();
		vi.setSystemTime(T0 - 2 * 60_000);
		tracker.recordDataPoint("a", 10, 60);
		vi.setSystemTime(T0 - 60_000);
		tracker.recordDataPoint("a", 10, 70);
		vi.setSystemTime(T0);

		await check();

		expect(emitted("proactive-swap-completed")[0]).toMatchObject({ limitType: "weekly" });
	});

	it("does not happen for a slow climb or a single earlier sample", async () => {
		usageByToken({ a: [60, 60], b: [5, 5] });
		const tracker = getVelocityTracker();
		vi.setSystemTime(T0 - 2 * 60_000);
		tracker.recordDataPoint("a", 58, 59);
		vi.setSystemTime(T0 - 60_000);
		tracker.recordDataPoint("a", 59, 59.5);
		vi.setSystemTime(T0);
		await check();

		tracker.clear();
		tracker.recordDataPoint("a", 10, 10);
		vi.setSystemTime(T0 + 16_000);
		await check();

		expect(world.calls.setActiveProfile).toEqual([]);
	});
});

describe("an Anthropic API key profile", () => {
	beforeEach(() => {
		world.apiFile.profiles = [
			{ id: "key", name: "Anthropic key", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-test-0000" },
		];
		world.apiFile.activeProfileId = "key";
		world.cli = { stdout: "Current session 40% used", stderr: "", code: 0 };
	});

	it("is measured by the CLI and completed with the week of a Claude account, never swapped", async () => {
		signIn("a");
		usageByToken({ a: [5, 77] });
		world.autoSwitch.sessionThreshold = 30;

		await check();

		expect(callsTo(OAUTH_USAGE).map((c) => c.headers.authorization)).toEqual([
			"Bearer token-a",
		]);
		expect(lastUsage()).toMatchObject({
			profileId: "key",
			profileName: "Anthropic key",
			sessionPercent: 40,
			weeklyPercent: 77,
			weeklyResetTimestamp: "2026-11-20T00:00:00Z",
		});
		expect(emitted("proactive-swap-completed")).toEqual([]);
	});

	it("keeps a week of 0 % when no Claude account can complete it", async () => {
		await check();
		expect(lastUsage().weeklyPercent).toBe(0);

		signIn("a");
		world.keychain.clear();
		vi.setSystemTime(T0 + 16_000);
		await check();
		expect(lastUsage().weeklyPercent).toBe(0);

		world.keychain.set("/home/tester/.claude-a", { token: "token-a", email: null });
		usageByToken({ a: [5, 0] });
		vi.setSystemTime(T0 + 32_000);
		await check();
		expect(lastUsage().weeklyPercent).toBe(0);
	});
});

describe("another provider selected", () => {
	beforeEach(() => {
		signIn("a");
		world.claude.activeProfileId = "a";
		world.windsurfPlan = {
			success: true,
			planInfo: {
				startTimestamp: T0 - 86_400_000,
				endTimestamp: T0 + 86_400_000,
				usage: { messages: 100, usedMessages: 100, flowActions: 0, usedFlowActions: 0 },
			},
		};
	});

	it("measures Windsurf when it is the selected provider, without touching Claude", async () => {
		world.settings = { selectedProvider: "windsurf" };

		await check();

		expect(lastUsage()).toMatchObject({
			profileId: "windsurf-local",
			providerName: "windsurf",
			sessionPercent: 100,
		});
		expect(tokenRefreshModule.ensureValidToken).not.toHaveBeenCalledWith(
			"/home/tester/.claude-a",
		);
		// Windsurf at 100 % is no reason to change Claude accounts
		expect(world.calls.setActiveProfile).toEqual([]);
		expect(world.writtenSettings).toEqual([]);
	});

	it("selects Windsurf when only its key is configured, and saves that choice", async () => {
		world.settings = { globalWindsurfApiKey: "svc-test-0000" };

		await check();

		expect(lastUsage().providerName).toBe("windsurf");
		expect(world.writtenSettings).toEqual([
			{ globalWindsurfApiKey: "svc-test-0000", selectedProvider: "windsurf" },
		]);

		world.settings = { globalWindsurfApiKey: "svc-test-0000" };
		world.settingsWriteError = new Error("EACCES");
		await check();
		expect(lastUsage().providerName).toBe("windsurf");
	});

	it("respects another explicit choice, and unreadable settings", async () => {
		usageByToken({ a: [1, 2] });
		world.settings = { selectedProvider: "anthropic", globalWindsurfApiKey: "svc-test-0000" };
		await check();
		expect(lastUsage().providerName).toBe("anthropic");

		world.settingsError = new Error("settings.json is corrupt");
		vi.setSystemTime(T0 + 16_000);
		await check();
		expect(lastUsage().providerName).toBe("anthropic");
	});

	it("measures Copilot for an active API profile without a key", async () => {
		world.apiFile.profiles = [
			{ id: "gh", name: "My Copilot", baseUrl: "https://api.github.com", apiKey: "" },
		];
		world.apiFile.activeProfileId = "gh";
		answer(`${BACKEND}/copilot`, json({ available: true }));

		await check();

		expect(lastUsage()).toMatchObject({
			profileId: "gh",
			profileName: "My Copilot",
			providerName: "copilot",
		});
	});

	it("does not mistake the Claude account's id for an API profile", async () => {
		usageByToken({ a: [1, 2] });
		world.apiFile.profiles = [
			{ id: "a", name: "Copilot", baseUrl: "https://api.github.com", apiKey: "" },
		];

		await check();

		expect(lastUsage()).toMatchObject({ profileName: "Account a", providerName: "anthropic" });
		expect(callsTo(BACKEND)).toEqual([]);
	});

	it("falls back to the Claude account for other keyless or missing API profiles", async () => {
		usageByToken({ a: [1, 2] });
		world.apiFile.profiles = [
			{ id: "x", name: "Keyless", baseUrl: "https://api.anthropic.com", apiKey: "" },
		];
		world.apiFile.activeProfileId = "x";
		await check();
		expect(lastUsage().profileId).toBe("a");

		world.apiFile.activeProfileId = "gone";
		vi.setSystemTime(T0 + 16_000);
		await check();
		expect(lastUsage().profileId).toBe("a");

		world.apiFileError = new Error("profiles.json is corrupt");
		vi.setSystemTime(T0 + 32_000);
		await check();
		expect(lastUsage().profileId).toBe("a");
	});

	it("reports what Copilot's backend cannot give", async () => {
		world.apiFile.profiles = [
			{ id: "gh", name: "My Copilot", baseUrl: "https://github.com", apiKey: "" },
		];
		world.apiFile.activeProfileId = "gh";
		const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
		answer(`${BACKEND}/copilot`, json({}, 500), abort, new TypeError("bad"));

		await check();
		await check();
		await check();
		expect(events).toEqual([]);

		world.routes.clear();
		await check();
		expect(lastUsage()).toMatchObject({
			profileName: "My Copilot",
			error: "BACKEND_UNAVAILABLE",
		});
	});
});
