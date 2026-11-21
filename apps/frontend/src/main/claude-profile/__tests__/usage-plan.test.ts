/**
 * The plan of the account the usage panel shows, read from local sources
 * only (stored login metadata, IDE state databases, CLI settings) and never
 * guessed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	AllProfilesUsage,
	ProfileUsageSummary,
	UsageSnapshot,
} from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
	home: "",
	profiles: new Map<string, Record<string, unknown>>(),
	profileManagerThrows: false,
	saved: [] as Array<Record<string, unknown>>,
	saveThrows: false,
	live: undefined as
		| { subscriptionType: string; rateLimitTier?: string }
		| undefined,
	keychain: {
		subscriptionType: null as string | null,
		rateLimitTier: null as string | null,
	},
	keychainThrows: false,
	apiProfiles: [] as Array<{ id: string; baseUrl: string; apiKey?: string }>,
	profilesFileThrows: false,
	settings: {} as Record<string, unknown>,
	settingsThrows: false,
	windsurf: { success: false } as {
		success: boolean;
		planInfo?: { planName: string };
	},
	windsurfRejects: false,
	cursorRow: undefined as { value: string | Buffer } | undefined,
	cursorOpenThrows: false,
	cursorClosed: 0,
	windows: false,
	mac: false,
}));

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => world.home };
});

vi.mock("../../claude-profile-manager", () => ({
	getClaudeProfileManager: () => {
		if (world.profileManagerThrows) throw new Error("not initialized");
		return {
			getProfile: (id: string) => world.profiles.get(id),
			saveProfile: (profile: Record<string, unknown>) => {
				if (world.saveThrows) throw new Error("disk full");
				world.saved.push(profile);
				return profile;
			},
		};
	},
}));

vi.mock("../claude-account-plan", () => ({
	readClaudeAccountPlan: vi.fn(async () => world.live),
}));

vi.mock("../credential-utils", () => ({
	getFullCredentialsFromKeychain: vi.fn(() => {
		if (world.keychainThrows) throw new Error("keychain locked");
		return { ...world.keychain };
	}),
}));

vi.mock("../../services/profile", () => ({
	loadProfilesFile: vi.fn(async () => {
		if (world.profilesFileThrows) throw new Error("no file");
		return { profiles: world.apiProfiles, activeProfileId: null };
	}),
}));

vi.mock("../../settings-utils", () => ({
	readSettingsFile: vi.fn(() => {
		if (world.settingsThrows) throw new Error("unreadable");
		return world.settings;
	}),
}));

vi.mock("../../services/credential-manager", () => ({
	readWindsurfCachedPlanInfo: vi.fn(async () => {
		if (world.windsurfRejects) throw new Error("db gone");
		return world.windsurf;
	}),
}));

vi.mock("../../services/windsurf-sqlite", () => ({
	loadBetterSqlite: () =>
		class FakeDatabase {
			constructor() {
				if (world.cursorOpenThrows) throw new Error("locked");
			}
			prepare() {
				return { get: () => world.cursorRow };
			}
			close() {
				world.cursorClosed += 1;
			}
		},
}));

vi.mock("../../platform", () => ({
	isWindows: () => world.windows,
	isMacOS: () => world.mac,
}));

import { readClaudeAccountPlan } from "../claude-account-plan";
import { getFullCredentialsFromKeychain } from "../credential-utils";
import {
	readCursorMembership,
	readGeminiCliAuthType,
	resetUsagePlanCache,
	withProfilesPlans,
	withUsagePlan,
} from "../usage-plan";

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		sessionPercent: 10,
		weeklyPercent: 20,
		profileId: "claude-1",
		profileName: "Me",
		fetchedAt: new Date(),
		providerName: "anthropic",
		...overrides,
	};
}

function cursorDbPath(): string {
	return path.join(
		world.home,
		".config",
		"Cursor",
		"User",
		"globalStorage",
		"state.vscdb",
	);
}

function writeCursorDb(): void {
	const dbPath = cursorDbPath();
	mkdirSync(path.dirname(dbPath), { recursive: true });
	writeFileSync(dbPath, "", "utf-8");
}

function writeGeminiSettings(content: string): void {
	const dir = path.join(world.home, ".gemini");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "settings.json"), content, "utf-8");
}

beforeEach(() => {
	world.home = mkdtempSync(path.join(tmpdir(), "usage-plan-"));
	world.profiles = new Map();
	world.profileManagerThrows = false;
	world.saved = [];
	world.saveThrows = false;
	world.live = undefined;
	world.keychain = { subscriptionType: null, rateLimitTier: null };
	world.keychainThrows = false;
	world.apiProfiles = [];
	world.profilesFileThrows = false;
	world.settings = {};
	world.settingsThrows = false;
	world.windsurf = { success: false };
	world.windsurfRejects = false;
	world.cursorRow = undefined;
	world.cursorOpenThrows = false;
	world.cursorClosed = 0;
	world.windows = false;
	world.mac = false;
	resetUsagePlanCache();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(world.home, { recursive: true, force: true });
});

describe("withUsagePlan — Claude", () => {
	it("names the subscription stored with the OAuth profile", async () => {
		world.profiles.set("claude-1", {
			id: "claude-1",
			subscriptionType: "max",
			rateLimitTier: "default_claude_max_20x",
		});
		const result = await withUsagePlan(snapshot());
		expect(result.plan).toEqual({
			billing: "subscription",
			name: "Claude Max 20x",
		});
		expect(getFullCredentialsFromKeychain).not.toHaveBeenCalled();
	});

	it("shows the plan the account has now and saves it over a stale login copy", async () => {
		// Signed in on Pro, moved to Max since.
		world.profiles.set("claude-1", {
			id: "claude-1",
			configDir: "/cfg",
			subscriptionType: "pro",
			rateLimitTier: "default_claude_ai",
		});
		world.live = { subscriptionType: "max", rateLimitTier: "default_claude_max_20x" };
		const result = await withUsagePlan(snapshot());
		expect(result.plan).toEqual({ billing: "subscription", name: "Claude Max 20x" });
		expect(readClaudeAccountPlan).toHaveBeenCalledWith("/cfg");
		expect(world.saved).toEqual([
			{
				id: "claude-1",
				configDir: "/cfg",
				subscriptionType: "max",
				rateLimitTier: "default_claude_max_20x",
			},
		]);
	});

	it("keeps the stored tier when the account's plan is the same and says no tier", async () => {
		world.profiles.set("claude-1", {
			id: "claude-1",
			subscriptionType: "max",
			rateLimitTier: "default_claude_max_5x",
		});
		world.live = { subscriptionType: "max" };
		expect((await withUsagePlan(snapshot())).plan?.name).toBe("Claude Max 5x");
		expect(world.saved).toEqual([]);
	});

	it("drops a tier stored for another plan", async () => {
		world.profiles.set("claude-1", {
			id: "claude-1",
			subscriptionType: "max",
			rateLimitTier: "default_claude_max_20x",
		});
		world.live = { subscriptionType: "pro" };
		expect((await withUsagePlan(snapshot())).plan?.name).toBe("Claude Pro");
		expect(world.saved[0]).toMatchObject({
			subscriptionType: "pro",
			rateLimitTier: undefined,
		});
	});

	it("shows the account's plan even when it cannot be saved", async () => {
		world.profiles.set("claude-1", { id: "claude-1", subscriptionType: "pro" });
		world.live = { subscriptionType: "max" };
		world.saveThrows = true;
		expect((await withUsagePlan(snapshot())).plan?.name).toBe("Claude Max");
	});

	it("reads the credentials store when the profile has no plan yet", async () => {
		world.profiles.set("claude-1", { id: "claude-1", configDir: "/cfg" });
		world.keychain = { subscriptionType: "pro", rateLimitTier: null };
		const result = await withUsagePlan(snapshot({ providerName: "claude" }));
		expect(result.plan).toEqual({ billing: "subscription", name: "Claude Pro" });
		expect(getFullCredentialsFromKeychain).toHaveBeenCalledWith("/cfg");
	});

	it("keeps the profile's tier when the credentials store only knows the type", async () => {
		world.profiles.set("claude-1", {
			id: "claude-1",
			rateLimitTier: "default_claude_max_5x",
		});
		world.keychain = { subscriptionType: "max", rateLimitTier: null };
		const result = await withUsagePlan(snapshot({ providerName: undefined }));
		expect(result.plan?.name).toBe("Claude Max 5x");
	});

	it("says subscription without a name when nothing names the plan", async () => {
		world.profiles.set("claude-1", { id: "claude-1" });
		expect((await withUsagePlan(snapshot())).plan).toEqual({
			billing: "subscription",
		});
		resetUsagePlanCache();
		world.keychainThrows = true;
		expect((await withUsagePlan(snapshot())).plan).toEqual({
			billing: "subscription",
		});
	});

	it("calls an Anthropic API key billed per use", async () => {
		world.apiProfiles = [
			{ id: "api-1", baseUrl: "https://api.anthropic.com", apiKey: "k" },
		];
		const byId = await withUsagePlan(snapshot({ profileId: "api-1" }));
		expect(byId.plan).toEqual({ billing: "api" });

		const byProvider = await withUsagePlan(
			snapshot({ profileId: "anthropic", usageUnmeasured: true }),
		);
		expect(byProvider.plan).toEqual({ billing: "api" });
	});

	it("ignores an API profile of another provider or without a key", async () => {
		world.apiProfiles = [
			{ id: "o", baseUrl: "https://api.openai.com", apiKey: "k" },
			{ id: "a", baseUrl: "https://api.anthropic.com", apiKey: "  " },
		];
		const result = await withUsagePlan(snapshot({ profileId: "anthropic" }));
		expect(result.plan).toBeUndefined();
	});

	it("falls back to the global API key setting", async () => {
		world.profilesFileThrows = true;
		world.settings = { globalAnthropicApiKey: "enc:abc" };
		const result = await withUsagePlan(snapshot({ profileId: "anthropic" }));
		expect(result.plan).toEqual({ billing: "api" });
	});

	it("shows nothing when neither a login nor a key is known", async () => {
		world.profileManagerThrows = true;
		world.settingsThrows = true;
		const result = await withUsagePlan(snapshot({ profileId: "anthropic" }));
		expect(result.plan).toBeUndefined();
	});
});

describe("withUsagePlan — OpenAI", () => {
	it("names the ChatGPT plan of a Codex login", async () => {
		const result = await withUsagePlan(
			snapshot({
				providerName: "openai",
				profileId: "openai-chatgpt",
				openaiSubscription: {
					planType: "plus",
					source: "chatgpt-usage-api",
					observedAt: "2026-11-15T10:00:00Z",
				},
			}),
		);
		expect(result.plan).toEqual({
			billing: "subscription",
			name: "ChatGPT Plus",
		});
	});

	it("calls the API-cost meter billed per use", async () => {
		const withDetails = await withUsagePlan(
			snapshot({
				providerName: "openai",
				profileId: "p",
				openaiUsageDetails: {},
			} as Partial<UsageSnapshot>),
		);
		expect(withDetails.plan).toEqual({ billing: "api" });

		world.settings = { globalOpenAIApiKey: "sk" };
		const withKey = await withUsagePlan(
			snapshot({ providerName: "openai", profileId: "openai" }),
		);
		expect(withKey.plan).toEqual({ billing: "api" });
	});

	it("shows nothing for OpenAI without a login or a key", async () => {
		const result = await withUsagePlan(
			snapshot({ providerName: "openai", profileId: "openai" }),
		);
		expect(result.plan).toBeUndefined();
	});
});

describe("withUsagePlan — Copilot, Windsurf", () => {
	it("names the Copilot plan reported with the quotas", async () => {
		const result = await withUsagePlan(
			snapshot({
				providerName: "copilot",
				profileId: "copilot",
				copilotUsageDetails: {
					scope: "personal-quotas",
					plan: "individual",
					sku: "plus_monthly_subscriber_quota",
				},
			}),
		);
		expect(result.plan).toEqual({
			billing: "subscription",
			name: "Copilot Pro+",
		});
	});

	it("says subscription when Copilot reports no plan", async () => {
		const result = await withUsagePlan(
			snapshot({ providerName: "copilot", profileId: "copilot" }),
		);
		expect(result.plan).toEqual({ billing: "subscription" });
	});

	it("shows nothing when reading the Copilot plan fails", async () => {
		const broken = snapshot({ providerName: "copilot", profileId: "copilot" });
		Object.defineProperty(broken, "copilotUsageDetails", {
			get() {
				throw new Error("unreadable");
			},
		});
		expect((await withUsagePlan(broken)).plan).toBeUndefined();
	});

	it("names the Windsurf plan the IDE caches", async () => {
		world.windsurf = { success: true, planInfo: { planName: "Pro" } };
		const result = await withUsagePlan(
			snapshot({ providerName: "windsurf", profileId: "windsurf-local" }),
		);
		expect(result.plan).toEqual({
			billing: "subscription",
			name: "Windsurf Pro",
		});
	});

	it("says subscription when Windsurf has no cached plan", async () => {
		const result = await withUsagePlan(
			snapshot({ providerName: "windsurf", profileId: "w" }),
		);
		expect(result.plan).toEqual({ billing: "subscription" });
	});

	it("shows nothing when the Windsurf database cannot be read", async () => {
		world.windsurfRejects = true;
		const result = await withUsagePlan(
			snapshot({ providerName: "windsurf", profileId: "w" }),
		);
		expect(result.plan).toBeUndefined();
	});
});

describe("withUsagePlan — Cursor", () => {
	it("names the membership stored by the IDE", async () => {
		writeCursorDb();
		world.cursorRow = { value: "pro" };
		const result = await withUsagePlan(
			snapshot({ providerName: "cursor", profileId: "cursor" }),
		);
		expect(result.plan).toEqual({ billing: "subscription", name: "Cursor Pro" });
		expect(world.cursorClosed).toBe(1);
	});

	it("falls back to an API key, then to nothing", async () => {
		world.apiProfiles = [{ id: "cursor-key", baseUrl: "https://x", apiKey: "" }];
		const byId = await withUsagePlan(
			snapshot({ providerName: "cursor", profileId: "cursor-key" }),
		);
		expect(byId.plan).toEqual({ billing: "api" });
		const none = await withUsagePlan(
			snapshot({ providerName: "cursor", profileId: "cursor" }),
		);
		expect(none.plan).toBeUndefined();
	});
});

describe("readCursorMembership", () => {
	it("reads a quoted or binary value", () => {
		writeCursorDb();
		world.cursorRow = { value: Buffer.from('"pro_plus"', "utf-8") };
		expect(readCursorMembership()).toBe("pro_plus");
	});

	it("refuses a value that is not a plan identifier", () => {
		writeCursorDb();
		world.cursorRow = { value: "<script>alert(1)</script>" };
		expect(readCursorMembership()).toBeUndefined();
		world.cursorRow = { value: 42 as unknown as string };
		expect(readCursorMembership()).toBeUndefined();
	});

	it("says nothing without a row, a readable database or a file", () => {
		writeCursorDb();
		expect(readCursorMembership()).toBeUndefined();
		world.cursorOpenThrows = true;
		expect(readCursorMembership()).toBeUndefined();
		expect(readCursorMembership(path.join(world.home, "absent"))).toBeUndefined();
	});

	it("looks where Cursor keeps its state on each OS", () => {
		world.windows = true;
		const appData = process.env.APPDATA;
		process.env.APPDATA = world.home;
		expect(readCursorMembership()).toBeUndefined();
		delete process.env.APPDATA;
		expect(readCursorMembership()).toBeUndefined();
		if (appData !== undefined) process.env.APPDATA = appData;
		world.windows = false;
		world.mac = true;
		expect(readCursorMembership()).toBeUndefined();
	});
});

describe("withUsagePlan — Gemini CLI", () => {
	const gemini = () =>
		withUsagePlan(snapshot({ providerName: "gemini-cli", profileId: "g" }));

	it("calls a Google login a subscription without naming it", async () => {
		writeGeminiSettings(JSON.stringify({ selectedAuthType: "oauth-personal" }));
		expect((await gemini()).plan).toEqual({ billing: "subscription" });
	});

	it("calls an API key or Vertex AI billed per use", async () => {
		writeGeminiSettings(
			JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }),
		);
		expect((await gemini()).plan).toEqual({ billing: "api" });
		resetUsagePlanCache();
		writeGeminiSettings(JSON.stringify({ selectedAuthType: "vertex-ai" }));
		expect((await gemini()).plan).toEqual({ billing: "api" });
	});

	it("shows nothing for another sign-in or no settings", async () => {
		writeGeminiSettings(JSON.stringify({ selectedAuthType: "cloud-shell" }));
		expect((await gemini()).plan).toBeUndefined();
	});
});

describe("readGeminiCliAuthType", () => {
	it("refuses what is not a readable sign-in type", async () => {
		const file = path.join(world.home, "settings.json");
		writeFileSync(file, "{not json", "utf-8");
		expect(await readGeminiCliAuthType(file)).toBeUndefined();
		writeFileSync(file, JSON.stringify({ selectedAuthType: 3 }), "utf-8");
		expect(await readGeminiCliAuthType(file)).toBeUndefined();
		writeFileSync(file, " ".repeat(1_000_001), "utf-8");
		expect(await readGeminiCliAuthType(file)).toBeUndefined();
		expect(await readGeminiCliAuthType()).toBeUndefined();
	});
});

describe("withUsagePlan — other providers", () => {
	it("calls a Mistral key billed per use", async () => {
		world.settings = { globalMistralApiKey: "m" };
		const result = await withUsagePlan(
			snapshot({ providerName: "mistral", profileId: "mistral" }),
		);
		expect(result.plan).toEqual({ billing: "api" });
	});

	it("shows nothing for a provider without a key setting or a local model", async () => {
		const opencode = await withUsagePlan(
			snapshot({ providerName: "opencode", profileId: "opencode" }),
		);
		expect(opencode.plan).toBeUndefined();
		world.apiProfiles = [{ id: "local", baseUrl: "http://localhost:11434" }];
		const local = await withUsagePlan(
			snapshot({ providerName: "ollama_local", profileId: "local" }),
		);
		expect(local.plan).toBeUndefined();
	});
});

describe("withUsagePlan — caching", () => {
	it("passes null through and keeps a plan already set", async () => {
		expect(await withUsagePlan(null)).toBeNull();
		const already = snapshot({ plan: { billing: "api" } });
		expect(await withUsagePlan(already)).toBe(already);
	});

	it("reads a plan once per account for five minutes", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-15T10:00:00Z"));
		world.profiles.set("claude-1", { id: "claude-1", configDir: "/cfg" });
		world.keychain = { subscriptionType: "pro", rateLimitTier: null };
		await withUsagePlan(snapshot());
		await withUsagePlan(snapshot());
		expect(getFullCredentialsFromKeychain).toHaveBeenCalledTimes(1);

		vi.setSystemTime(new Date("2026-11-15T10:06:00Z"));
		world.keychain = { subscriptionType: "max", rateLimitTier: null };
		const later = await withUsagePlan(snapshot());
		expect(later.plan?.name).toBe("Claude Max");
		expect(getFullCredentialsFromKeychain).toHaveBeenCalledTimes(2);
	});
});

describe("withProfilesPlans", () => {
	function summary(
		overrides: Partial<ProfileUsageSummary> = {},
	): ProfileUsageSummary {
		return {
			profileId: "claude-2",
			profileName: "Other",
			sessionPercent: 0,
			weeklyPercent: 0,
			isAuthenticated: true,
			isRateLimited: false,
			availabilityScore: 1,
			isActive: false,
			...overrides,
		};
	}

	it("passes null through", async () => {
		expect(await withProfilesPlans(null)).toBeNull();
	});

	it("adds the plan of the active account and of every other one", async () => {
		world.profiles.set("claude-1", { id: "claude-1", subscriptionType: "pro" });
		world.profiles.set("claude-2", {
			id: "claude-2",
			subscriptionType: "max",
			rateLimitTier: "default_claude_max_5x",
		});
		const kept = summary({
			profileId: "claude-3",
			plan: { billing: "subscription", name: "Claude Team" },
		});
		const unknown = summary({ profileId: "gone" });
		const usage: AllProfilesUsage = {
			activeProfile: snapshot(),
			allProfiles: [summary(), kept, unknown],
			fetchedAt: new Date(),
		};
		const result = await withProfilesPlans(usage);
		expect(result?.activeProfile.plan?.name).toBe("Claude Pro");
		expect(result?.allProfiles[0].plan?.name).toBe("Claude Max 5x");
		expect(result?.allProfiles[1]).toBe(kept);
		expect(result?.allProfiles[2]).toBe(unknown);
	});
});
