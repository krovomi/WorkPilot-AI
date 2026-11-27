/**
 * getUsageForProvider: what the usage badge shows for each provider, read from
 * a faked machine (usage-monitor-world.ts) — profiles, settings, credential
 * stores, the network by URL and the `claude usage` command.
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
import { UsageMonitor } from "../usage-monitor";
import { getVelocityTracker } from "../velocity-tracker";
import {
	answer,
	callsTo,
	fakeFetch,
	json,
	resetWorld,
	world,
} from "./usage-monitor-world";

const BACKEND = "http://127.0.0.1:9000/providers/usage";
const CODEIUM = "https://server.codeium.com";
const CREDITS = `${CODEIUM}/api/v1/GetTeamCreditBalance`;
const GET_USER = `${CODEIUM}/exa.api_server_pb.ApiServerService/GetUser`;
const TEAM_INFO = `${CODEIUM}/exa.api_server_pb.ApiServerService/GetTeamInfo`;
const OAUTH_USAGE = "https://api.anthropic.com/api/oauth/usage";

type Extra = Record<string, unknown>;

const newMonitor = () =>
	new (UsageMonitor as unknown as new () => UsageMonitor)();

let monitor: UsageMonitor;
let warnings: string[];
const savedEnv = { ...process.env };

beforeEach(() => {
	resetWorld();
	getVelocityTracker().clear();
	vi.stubGlobal("fetch", fakeFetch);
	warnings = [];
	vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	delete process.env.OPENAI_API_KEY;
	delete process.env.WINDSURF_API_KEY;
	delete process.env.CODEIUM_API_KEY;
	monitor = newMonitor();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
	process.env = { ...savedEnv };
});

describe("requests for the same provider", () => {
	it("share one fetch while it is in flight, then fetch again", async () => {
		answer(`${BACKEND}/copilot`, json({ available: false }));

		const [a, b] = await Promise.all([
			monitor.getUsageForProvider("copilot"),
			monitor.getUsageForProvider("copilot"),
		]);
		expect(a).toBe(b);
		expect(callsTo(`${BACKEND}/copilot`)).toHaveLength(1);

		await monitor.getUsageForProvider("copilot");
		expect(callsTo(`${BACKEND}/copilot`)).toHaveLength(2);
	});
});

describe("GitHub Copilot", () => {
	it("shows the premium requests of a personal plan, bounded to 0-100", async () => {
		answer(
			`${BACKEND}/copilot`,
			json({
				available: true,
				usage: {},
				fetched_at: "2026-11-15T08:00:00.000Z",
				copilotUsageDetails: {
					scope: "personal-quotas",
					premiumRequestsPercentUsed: 140,
					premiumRequestsUsed: 420,
					premiumRequestsEntitlement: 300,
					quotaResetDate: "2026-12-01",
				},
			}),
		);

		const usage = await monitor.getUsageForProvider("copilot");

		expect(usage).toMatchObject({
			sessionPercent: 100,
			weeklyPercent: 100,
			sessionResetTimestamp: "2026-12-01",
			sessionUsageValue: 420,
			sessionUsageLimit: 300,
			profileId: "copilot",
			profileName: "GitHub Copilot",
			providerName: "copilot",
		});
		expect(usage?.fetchedAt.toISOString()).toBe("2026-11-15T08:00:00.000Z");
	});

	it("shows 0 % for an unlimited plan or a percent it does not get", async () => {
		const plan = (details: Extra) =>
			json({
				available: true,
				usage: {},
				copilotUsageDetails: { scope: "personal-quotas", ...details },
			});
		answer(
			`${BACKEND}/copilot`,
			plan({ premiumRequestsUnlimited: true, premiumRequestsPercentUsed: 80 }),
			plan({ premiumRequestsPercentUsed: "80" }),
			plan({ premiumRequestsPercentUsed: -5 }),
		);

		for (let i = 0; i < 3; i++) {
			expect((await monitor.getUsageForProvider("copilot"))?.sessionPercent).toBe(0);
		}
	});

	it("derives a percent from the suggestions of an organization", async () => {
		answer(
			`${BACKEND}/copilot`,
			json({
				available: true,
				usage: {
					total_suggestions: 250,
					total_acceptances: 100,
					acceptance_rate_percent: 40,
					total_tokens: 9000,
					total_lines_suggested: 600,
					total_lines_accepted: 200,
					line_acceptance_rate_percent: 33,
					organization: "acme",
					level: "org",
				},
				fetched_at: "2026-11-14T00:00:00.000Z",
			}),
		);

		const usage = (await monitor.getUsageForProvider("copilot")) as UsageSnapshot &
			Extra;

		expect(usage).toMatchObject({
			sessionPercent: 25,
			weeklyPercent: 25,
			linesSuggested: 600,
			linesAccepted: 200,
			lineAcceptanceRate: 33,
			organization: "acme",
			level: "org",
		});
		expect(usage.copilotUsageDetails).toMatchObject({
			totalTokens: 9000,
			suggestionsCount: 250,
			acceptancesCount: 100,
			acceptanceRate: 40,
			lastUpdated: "2026-11-14T00:00:00.000Z",
		});
	});

	it("falls back to the details block and caps the percent", async () => {
		answer(
			`${BACKEND}/copilot`,
			json({
				available: true,
				usage: {},
				copilotUsageDetails: {
					suggestions: 5000,
					acceptances: 7,
					acceptanceRate: 12,
				},
			}),
			json({ available: true, usage: {} }),
		);

		const usage = (await monitor.getUsageForProvider("copilot")) as UsageSnapshot &
			Extra;
		expect(usage.sessionPercent).toBe(100);
		expect(usage.copilotUsageDetails).toMatchObject({
			totalTokens: 0,
			suggestionsCount: 5000,
			acceptancesCount: 7,
			acceptanceRate: 12,
		});
		expect(usage).not.toHaveProperty("organization");

		const empty = await monitor.getUsageForProvider("copilot");
		expect(empty?.sessionPercent).toBe(0);
		expect(empty?.copilotUsageDetails).toMatchObject({
			acceptancesCount: 0,
			acceptanceRate: 0,
		});
	});

	it("passes on the error the backend reports", async () => {
		answer(
			`${BACKEND}/copilot`,
			json({
				error: "PERMISSION_REQUIRED",
				message: "The token cannot read usage",
				permission_required: "manage_billing:copilot",
			}),
			json({ error: "NOT_SIGNED_IN" }),
		);

		expect(await monitor.getUsageForProvider("copilot")).toMatchObject({
			sessionPercent: 0,
			providerName: "copilot",
			error: "PERMISSION_REQUIRED",
			errorMessage: "The token cannot read usage",
			permissionRequired: "manage_billing:copilot",
		});
		const bare = (await monitor.getUsageForProvider("copilot")) as unknown as Extra;
		expect(bare.error).toBe("NOT_SIGNED_IN");
		expect(bare).not.toHaveProperty("errorMessage");
		expect(bare).not.toHaveProperty("permissionRequired");
	});

	it("says no data is available when the backend has none", async () => {
		answer(`${BACKEND}/copilot`, json({ available: true }));

		expect(await monitor.getUsageForProvider("copilot")).toMatchObject({
			sessionPercent: 0,
			errorMessage: "No usage data available",
		});
	});

	it("reports a backend that answers with an error status", async () => {
		answer(`${BACKEND}/copilot`, json({}, 503));

		expect(await monitor.getUsageForProvider("copilot")).toMatchObject({
			error: "BACKEND_ERROR",
			errorMessage: "Backend returned 503: Status 503",
		});
	});

	it("says the backend is not started when nothing listens, null on other failures", async () => {
		expect(await monitor.getUsageForProvider("copilot")).toMatchObject({
			error: "BACKEND_UNAVAILABLE",
		});

		answer(`${BACKEND}/copilot`, new TypeError("fetch failed"));
		expect(await monitor.getUsageForProvider("copilot")).toBeNull();
	});
});

describe("Windsurf, from the IDE's cached plan", () => {
	const plan = (usage: Extra, extra: Extra = {}) => ({
		success: true,
		userName: "Ada",
		planInfo: {
			planName: "Pro",
			startTimestamp: Date.parse("2026-11-01T00:00:00Z"),
			endTimestamp: Date.parse("2026-12-01T00:00:00Z"),
			usage: {
				messages: 50000,
				usedMessages: 33600,
				flowActions: 150000,
				usedFlowActions: 1200,
				...usage,
			},
			...extra,
		},
	});

	it("reads counts stored in hundredths and estimates the week", async () => {
		world.windsurfPlan = plan({});

		const usage = await monitor.getUsageForProvider("windsurf");

		expect(usage).toMatchObject({
			sessionPercent: 67,
			weeklyPercent: 17,
			profileId: "windsurf-local",
			profileName: "Windsurf (Ada)",
			providerName: "windsurf",
			sessionUsageValue: 336,
			sessionUsageLimit: 500,
			sessionResetTimestamp: "2026-12-01T00:00:00.000Z",
		});
		expect(usage?.windsurfCredits).toMatchObject({
			totalCredits: 500,
			usedCredits: 336,
			remainingCredits: 164,
			addOnCreditsAvailable: 1500,
			addOnCreditsUsed: 12,
			billingCycleStart: "2026-11-01T00:00:00.000Z",
		});
		expect(callsTo(CODEIUM)).toHaveLength(0);
	});

	it("keeps plain counts, never shows a negative remainder, and copes with an empty plan", async () => {
		world.windsurfPlan = { ...plan({ messages: 150, usedMessages: 180 }), userName: undefined };
		const over = await monitor.getUsageForProvider("windsurf");
		expect(over).toMatchObject({
			profileName: "Windsurf (Codeium)",
			sessionPercent: 120,
			sessionUsageLimit: 150,
		});
		expect(over?.windsurfCredits?.remainingCredits).toBe(0);

		world.windsurfPlan = plan({ messages: 0, usedMessages: 0 }, { isStale: true });
		expect(await monitor.getUsageForProvider("windsurf")).toMatchObject({
			sessionPercent: 0,
			weeklyPercent: 0,
		});
	});
});

describe("Windsurf, from the Codeium API", () => {
	const credits = {
		promptCreditsPerSeat: 500,
		numSeats: 2,
		addOnCreditsAvailable: 100,
		addOnCreditsUsed: 400,
		billingCycleStart: "2026-11-01T00:00:00.000Z",
		billingCycleEnd: "2026-12-01T00:00:00.000Z",
	};

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-16T00:00:00.000Z"));
	});

	it("sends the key of the Windsurf API profile in the body", async () => {
		world.apiFile.profiles = [
			{ id: "ws", name: "Team", baseUrl: "https://windsurf.com", apiKey: "svc-test-0000" },
		];
		answer(CREDITS, json(credits));

		const usage = await monitor.getUsageForProvider("windsurf");

		expect(callsTo(CREDITS)[0]).toMatchObject({
			method: "POST",
			body: JSON.stringify({ service_key: "svc-test-0000" }),
		});
		expect(callsTo(CREDITS)[0].headers).not.toHaveProperty("authorization");
		expect(usage).toMatchObject({
			profileId: "ws",
			profileName: "Team",
			sessionPercent: 27, // 400 used of 1000 + 100 + 400
			weeklyPercent: 50, // 15 of 30 days
			limitType: "weekly",
			sessionUsageValue: 400,
			sessionUsageLimit: 1500,
		});
		expect(usage?.windsurfCredits).toMatchObject({
			seatCreditsTotal: 1000,
			remainingCredits: 1100,
			numSeats: 2,
		});
	});

	it("prefers message counts, and leaves the cycle at 0 % before it starts", async () => {
		world.apiFile.profiles = [
			{ id: "ws", name: "Team", baseUrl: "https://codeium.com", apiKey: "svc-test-0000" },
		];
		answer(
			CREDITS,
			json({
				totalMessages: 200,
				usedMessages: 50,
				billingCycleStart: "2026-12-01T00:00:00.000Z",
				billingCycleEnd: "2026-12-31T00:00:00.000Z",
			}),
			json({}),
		);

		expect(await monitor.getUsageForProvider("windsurf")).toMatchObject({
			sessionPercent: 25,
			weeklyPercent: 0,
			sessionUsageValue: 50,
			sessionUsageLimit: 200,
		});
		const bare = await monitor.getUsageForProvider("windsurf");
		expect(bare).toMatchObject({ sessionPercent: 0, weeklyPercent: 0 });
		expect(bare?.sessionResetTimestamp).toBeUndefined();
		expect(bare?.windsurfCredits?.numSeats).toBe(1);
	});

	it("retries with a Bearer header when the body key is refused", async () => {
		world.settings = { globalWindsurfApiKey: "  svc-test-1111  " };
		answer(CREDITS, json({}, 401), json(credits));

		const usage = await monitor.getUsageForProvider("windsurf");

		const [first, second] = callsTo(CREDITS);
		expect(first.body).toBe(JSON.stringify({ service_key: "svc-test-1111" }));
		expect(second.headers.authorization).toBe("Bearer svc-test-1111");
		expect(second.body).toBe("{}");
		expect(usage).toMatchObject({
			profileId: "windsurf-global",
			profileName: "Windsurf (Codeium)",
		});
	});

	it("takes the key from WINDSURF_API_KEY, then CODEIUM_API_KEY", async () => {
		answer(CREDITS, json(credits));
		process.env.WINDSURF_API_KEY = "svc-test-2222";
		expect(await monitor.getUsageForProvider("windsurf")).toMatchObject({
			profileId: "windsurf-env",
			profileName: "Windsurf (env)",
		});

		delete process.env.WINDSURF_API_KEY;
		process.env.CODEIUM_API_KEY = "svc-test-3333";
		world.settingsError = new Error("settings unreadable");
		await monitor.getUsageForProvider("windsurf");
		expect(callsTo(CREDITS)[1].body).toContain("svc-test-3333");
	});

	it("uses the SSO token the IDE holds, with a Bearer header only", async () => {
		world.windsurfToken = { success: true, apiKey: "eyJ.sso.test", userName: "Ada" };
		answer(CREDITS, json(credits));

		const usage = await monitor.getUsageForProvider("windsurf");

		expect(callsTo(CREDITS)).toHaveLength(1);
		expect(callsTo(CREDITS)[0].headers.authorization).toBe("Bearer eyJ.sso.test");
		expect(usage).toMatchObject({ profileId: "windsurf-sso", profileName: "Windsurf (Ada)" });

		world.windsurfToken = { success: true, apiKey: "eyJ.sso.test" };
		expect((await monitor.getUsageForProvider("windsurf"))?.profileName).toBe(
			"Windsurf (SSO)",
		);
	});

	it("shows Windsurf as connected but unmeasured without any key", async () => {
		world.windsurfPlanError = new Error("database is locked");
		world.windsurfTokenError = new Error("no IDE");
		world.windsurfToken = { success: false };

		expect(await monitor.getUsageForProvider("windsurf")).toMatchObject({
			profileId: "windsurf-global",
			providerName: "windsurf",
			usageUnmeasured: true,
		});
		expect(callsTo(CODEIUM)).toHaveLength(0);

		world.windsurfTokenError = null;
		world.windsurfToken = { success: true };
		expect((await monitor.getUsageForProvider("windsurf"))?.usageUnmeasured).toBe(true);
	});

	it("names the SSO user and reads the team's credits when the balance is refused", async () => {
		world.windsurfToken = { success: true, apiKey: "eyJ.sso.test" };
		answer(CREDITS, json({}, 403));
		answer(GET_USER, json({ email: "ada@example.com" }));
		answer(TEAM_INFO, json(credits));

		const usage = await monitor.getUsageForProvider("windsurf");

		expect(usage).toMatchObject({
			profileName: "Windsurf (SSO) (ada@example.com)",
			sessionPercent: 27,
		});
		expect(callsTo(TEAM_INFO)[0].headers.authorization).toBe("Bearer eyJ.sso.test");
	});

	it("returns a connected snapshot when the team info has no credits or fails", async () => {
		world.windsurfToken = { success: true, apiKey: "eyJ.sso.test" };
		answer(CREDITS, json({}, 403));
		answer(GET_USER, json({ name: "Ada" }), json({}), new Error("reset"));
		answer(TEAM_INFO, json({ teamName: "acme" }), json({}, 500), new Error("reset"));

		expect(await monitor.getUsageForProvider("windsurf")).toMatchObject({
			profileName: "Windsurf (SSO) (Ada)",
			usageUnmeasured: true,
		});
		expect((await monitor.getUsageForProvider("windsurf"))?.profileName).toBe(
			"Windsurf (SSO) (Windsurf User)",
		);
		expect((await monitor.getUsageForProvider("windsurf"))?.profileName).toBe(
			"Windsurf (SSO)",
		);
	});

	it("asks no team info for a service key and keeps the profile name", async () => {
		world.settings = { globalWindsurfApiKey: "svc-test-4444" };
		answer(CREDITS, json({}, 500));
		answer(GET_USER, json({}, 401));

		expect(await monitor.getUsageForProvider("windsurf")).toMatchObject({
			profileName: "Windsurf (Codeium)",
			usageUnmeasured: true,
		});
		expect(callsTo(TEAM_INFO)).toHaveLength(0);
	});

	it("returns null when the API profiles cannot be read", async () => {
		world.apiFileError = new Error("profiles.json is corrupt");

		expect(await monitor.getUsageForProvider("windsurf")).toBeNull();
	});
});

describe("OpenAI", () => {
	const limits = {
		primary: { usedPercent: 40, windowMinutes: 300, resetsAt: "2026-11-15T12:00:00Z" },
		secondary: { usedPercent: 70, windowMinutes: 10080, resetsAt: "2026-11-20T00:00:00Z" },
		planType: "plus",
		source: "chatgpt-usage-api",
		observedAt: "2026-11-15T08:00:00Z",
	};

	it("shows the ChatGPT plan's windows when signed in with codex and caches them", async () => {
		world.settings = { globalOpenAIAuthMode: "codex-cli", globalOpenAIApiKey: "sk-test-0000" };
		world.codex = limits;

		const usage = await monitor.getUsageForProvider("openai");

		expect(usage).toMatchObject({
			profileId: "openai-chatgpt",
			profileName: "ChatGPT Plus",
			sessionPercent: 40,
			weeklyPercent: 70,
			providerName: "openai",
		});
		world.codex = { ...limits, primary: { ...limits.primary, usedPercent: 99 } };
		expect((await monitor.getUsageForProvider("openai"))?.sessionPercent).toBe(40);
	});

	it("asks the plan when no API key is set anywhere, and names it ChatGPT without a plan type", async () => {
		world.settingsError = new Error("unreadable");
		world.apiFileError = new Error("no profiles file");
		world.codex = { ...limits, planType: undefined };

		expect((await monitor.getUsageForProvider("openai"))?.profileName).toBe("ChatGPT");
	});

	it("does not ask the plan when an API key is spent instead", async () => {
		world.codex = limits;
		world.apiFile.profiles = [
			{ id: "oa", name: "OpenAI key", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test-0000" },
		];
		answer(`${BACKEND}/openai`, json({ usage: { total_tokens: 10 } }));

		const fromProfile = await monitor.getUsageForProvider("openai");
		expect(fromProfile).toMatchObject({
			profileId: "oa",
			profileName: "OpenAI key",
			providerName: "openai",
			openaiUsageDetails: { usage: { total_tokens: 10 } },
		});

		world.apiFile.profiles = [];
		process.env.OPENAI_API_KEY = "sk-test-1111";
		expect(await monitor.getUsageForProvider("openai")).toMatchObject({
			profileId: "openai",
			profileName: "OpenAI",
			usageUnmeasured: true,
		});

		delete process.env.OPENAI_API_KEY;
		world.settings = { globalOpenAIApiKey: "sk-test-2222" };
		expect((await monitor.getUsageForProvider("openai"))?.profileId).toBe("openai");
	});

	it("falls through when the plan has no limits or the lookup fails", async () => {
		world.codex = null;
		expect((await monitor.getUsageForProvider("openai"))?.usageUnmeasured).toBe(true);

		world.codexError = new Error("auth.json unreadable");
		expect((await monitor.getUsageForProvider("openai"))?.usageUnmeasured).toBe(true);
	});

	it("returns null when the backend fails for an API key profile", async () => {
		world.apiFile.profiles = [
			{ id: "oa", name: "OpenAI key", baseUrl: "https://api.openai.com", apiKey: "sk-test-0000" },
		];
		answer(`${BACKEND}/openai`, json({}, 500), new Error("socket hang up"));

		expect(await monitor.getUsageForProvider("openai")).toBeNull();
		expect(await monitor.getUsageForProvider("openai")).toBeNull();
	});
});

describe("providers without a usage endpoint", () => {
	it("show the API profile's own name, unmeasured", async () => {
		world.apiFile.profiles = [
			{ id: "local", name: "My Ollama", baseUrl: "http://localhost:11434", apiKey: "ollama" },
		];

		expect(await monitor.getUsageForProvider("ollama_local")).toMatchObject({
			profileId: "local",
			profileName: "My Ollama",
			providerName: "ollama_local",
			usageUnmeasured: true,
		});
		expect(world.fetchCalls).toHaveLength(0);
	});

	it("show the provider's label when no profile matches", async () => {
		world.apiFileError = new Error("profiles.json is corrupt");

		expect(await monitor.getUsageForProvider("mistral")).toMatchObject({
			profileId: "mistral",
			profileName: "Mistral AI",
			usageUnmeasured: true,
		});
		expect(warnings.join("\n")).toContain("Failed to search API profiles");
	});
});

describe("Anthropic", () => {
	const work = {
		id: "work",
		name: "Work",
		email: "work@example.com",
		configDir: "/home/tester/.claude-work",
	};

	beforeEach(() => {
		world.claude.profiles = [work];
		world.claude.activeProfileId = "work";
	});

	it("reads the OAuth usage of the best profile, even with an Anthropic API key around", async () => {
		world.apiFile.profiles = [
			{ id: "key", name: "Anthropic key", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-test-0000" },
		];
		world.keychain.set(work.configDir, { token: "oauth-test-token", email: null });
		answer(
			OAUTH_USAGE,
			json({
				five_hour: { utilization: 30, resets_at: "2026-11-15T12:00:00Z" },
				seven_day: { utilization: 60, resets_at: "2026-11-20T00:00:00Z" },
			}),
		);

		const usage = await monitor.getUsageForProvider("claude");

		expect(usage).toMatchObject({
			profileId: "work",
			profileName: "Work",
			profileEmail: "work@example.com",
			sessionPercent: 30,
			weeklyPercent: 60,
			limitType: "weekly",
			providerName: "anthropic",
		});
		expect(callsTo(OAUTH_USAGE)[0].headers).toMatchObject({
			authorization: "Bearer oauth-test-token",
			"anthropic-beta": "oauth-2025-04-20",
		});
	});

	it("names the usage from the CLI when the API fails", async () => {
		world.keychain.set(work.configDir, { token: "oauth-test-token", email: null });
		answer(OAUTH_USAGE, json({ error: "server overloaded" }, 529));
		world.cli = { stdout: "Current session 12% used\nCurrent week (all models) 34% used", stderr: "", code: 0 };

		expect(await monitor.getUsageForProvider("anthropic")).toMatchObject({
			sessionPercent: 12,
			weeklyPercent: 34,
			providerName: "anthropic",
		});
	});

	it("falls back to the last usage of the same provider, then to a minimal snapshot", async () => {
		world.initError = new Error("profiles not loaded yet");
		world.keychain.set(work.configDir, { token: "oauth-test-token", email: null });
		answer(OAUTH_USAGE, json({}, 500));
		world.cli = { stdout: "", stderr: "not logged in", code: 1 };
		const last = { sessionPercent: 5, providerName: "anthropic" } as UsageSnapshot;
		(monitor as unknown as { currentUsage: UsageSnapshot }).currentUsage = last;

		expect(await monitor.getUsageForProvider("anthropic")).toBe(last);
		expect(warnings.join("\n")).toContain("fetchUsage returned null");

		(monitor as unknown as { currentUsage: null }).currentUsage = null;
		world.keychain.clear();
		expect(await monitor.getUsageForProvider("anthropic")).toMatchObject({
			profileId: "anthropic",
			profileName: "Anthropic",
			usageUnmeasured: true,
		});
		expect(warnings.join("\n")).toContain("No credential found for OAuth profile");
	});

	it("warns when there is no OAuth profile or the lookup fails", async () => {
		world.claude.profiles = [];
		await monitor.getUsageForProvider("anthropic");
		expect(warnings.join("\n")).toContain("No OAuth profiles found");

		const failing = vi
			.spyOn(
				(await import("./usage-monitor-world")).profileManager,
				"getProfilesSortedByAvailability",
			)
			.mockImplementation(() => {
				throw new Error("profiles store busy");
			});
		expect((await monitor.getUsageForProvider("anthropic"))?.usageUnmeasured).toBe(true);
		expect(warnings.join("\n")).toContain("Step 2 OAuth lookup failed");
		failing.mockRestore();
	});
});
