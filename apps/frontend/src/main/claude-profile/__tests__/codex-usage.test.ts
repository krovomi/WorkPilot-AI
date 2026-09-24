import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CHATGPT_USAGE_URL,
	codexLimitsToSnapshot,
	fetchCodexRateLimits,
	parseChatGPTUsageResponse,
	parseRateLimitsFromRollout,
	readCodexAuth,
	splitSessionWeekly,
} from "../codex-usage";

const NOW = Date.parse("2026-09-24T10:00:00Z");

describe("parseChatGPTUsageResponse", () => {
	it("reads both windows of the usage API", () => {
		const limits = parseChatGPTUsageResponse(
			{
				plan_type: "plus",
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: {
						used_percent: 42,
						limit_window_seconds: 18000,
						reset_after_seconds: 3600,
						reset_at: NOW / 1000 + 3600,
					},
					secondary_window: {
						used_percent: 17,
						limit_window_seconds: 604800,
						reset_after_seconds: 86400,
						reset_at: NOW / 1000 + 86400,
					},
				},
			},
			NOW,
		);
		expect(limits).toMatchObject({
			planType: "plus",
			source: "chatgpt-usage-api",
			primary: { usedPercent: 42, windowMinutes: 300 },
			secondary: { usedPercent: 17, windowMinutes: 10080 },
		});
		expect(limits?.primary?.resetsAt).toBe(
			new Date(NOW + 3600 * 1000).toISOString(),
		);
	});

	it("returns null when the body carries no window", () => {
		expect(parseChatGPTUsageResponse({ plan_type: "free" }, NOW)).toBeNull();
		expect(parseChatGPTUsageResponse(null, NOW)).toBeNull();
	});
});

describe("parseRateLimitsFromRollout", () => {
	const line = (timestamp: string, rateLimits: unknown) =>
		JSON.stringify({
			timestamp,
			type: "event_msg",
			payload: { type: "token_count", info: null, rate_limits: rateLimits },
		});

	it("takes the newest token_count event", () => {
		const content = [
			line("2026-09-24T09:00:00Z", {
				primary: { used_percent: 10, window_minutes: 300, resets_in_seconds: 9000 },
			}),
			line("2026-09-24T09:30:00Z", {
				primary: { used_percent: 25, window_minutes: 300, resets_in_seconds: 7200 },
				secondary: { used_percent: 5, window_minutes: 10080, resets_in_seconds: 500000 },
			}),
			"",
		].join("\n");
		const limits = parseRateLimitsFromRollout(content, NOW);
		expect(limits?.source).toBe("codex-session-log");
		expect(limits?.primary?.usedPercent).toBe(25);
		expect(limits?.secondary?.usedPercent).toBe(5);
		expect(limits?.primary?.resetsAt).toBe(
			new Date(Date.parse("2026-09-24T09:30:00Z") + 7200 * 1000).toISOString(),
		);
	});

	it("reports a window that has reset since the log as empty", () => {
		const content = line("2026-09-24T01:00:00Z", {
			primary: { used_percent: 90, window_minutes: 300, resets_at: NOW / 1000 - 60 },
			secondary: { used_percent: 40, window_minutes: 10080, resets_at: NOW / 1000 + 3600 },
		});
		const limits = parseRateLimitsFromRollout(content, NOW);
		expect(limits?.primary).toEqual({
			usedPercent: 0,
			windowMinutes: 300,
			resetsAt: undefined,
		});
		expect(limits?.secondary?.usedPercent).toBe(40);
	});

	it("ignores lines without rate limits or unparseable lines", () => {
		expect(
			parseRateLimitsFromRollout('{"rate_limits": broken\n{"type":"x"}', NOW),
		).toBeNull();
	});
});

describe("splitSessionWeekly", () => {
	it("orders by window length rather than by name", () => {
		const { session, weekly } = splitSessionWeekly({
			primary: { usedPercent: 3, windowMinutes: 10080 },
			secondary: { usedPercent: 50, windowMinutes: 300 },
			source: "chatgpt-usage-api",
			observedAt: new Date(NOW).toISOString(),
		});
		expect(session?.usedPercent).toBe(50);
		expect(weekly?.usedPercent).toBe(3);
	});
});

describe("codexLimitsToSnapshot", () => {
	it("marks a missing weekly window as N/A (-1), never 0", () => {
		const snapshot = codexLimitsToSnapshot(
			{
				primary: { usedPercent: 12, windowMinutes: 300 },
				source: "chatgpt-usage-api",
				observedAt: new Date(NOW).toISOString(),
			},
			{ profileId: "openai-chatgpt", profileName: "ChatGPT" },
		);
		expect(snapshot.sessionPercent).toBe(12);
		expect(snapshot.weeklyPercent).toBe(-1);
		expect(snapshot.providerName).toBe("openai");
		expect(snapshot.openaiSubscription?.source).toBe("chatgpt-usage-api");
		expect(snapshot.usageWindows?.sessionWindowLabel).toBe(
			"common:usage.window5Hour",
		);
	});
});

describe("fetchCodexRateLimits", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(path.join(tmpdir(), "codex-home-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	const writeAuth = (content: unknown) =>
		writeFileSync(path.join(home, "auth.json"), JSON.stringify(content));

	const writeRollout = (content: string) => {
		const dir = path.join(home, "sessions", "2026", "09", "24");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "rollout-2026-09-24T09-00-00-abc.jsonl"), content);
	};

	it("asks the usage API with the ChatGPT token and account id", async () => {
		writeAuth({
			tokens: { access_token: "aaa.bbb.ccc", account_id: "acc-1", refresh_token: "r" },
		});
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				rate_limit: {
					primary_window: { used_percent: 30, limit_window_seconds: 18000 },
					secondary_window: { used_percent: 8, limit_window_seconds: 604800 },
				},
			}),
		});
		const limits = await fetchCodexRateLimits({
			codexHome: home,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: NOW,
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			CHATGPT_USAGE_URL,
			expect.objectContaining({
				redirect: "error",
				headers: expect.objectContaining({
					Authorization: "Bearer aaa.bbb.ccc",
					"ChatGPT-Account-Id": "acc-1",
				}),
			}),
		);
		expect(limits?.primary?.usedPercent).toBe(30);
		expect(limits?.source).toBe("chatgpt-usage-api");
	});

	it("falls back to the session log when the token is refused", async () => {
		writeAuth({ tokens: { access_token: "old.expired.token" } });
		writeRollout(
			JSON.stringify({
				timestamp: "2026-09-24T09:50:00Z",
				type: "event_msg",
				payload: {
					type: "token_count",
					rate_limits: {
						primary: { used_percent: 64, window_minutes: 300, resets_in_seconds: 1800 },
						secondary: { used_percent: 21, window_minutes: 10080, resets_in_seconds: 90000 },
					},
				},
			}),
		);
		const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });
		const limits = await fetchCodexRateLimits({
			codexHome: home,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: NOW,
		});
		expect(limits?.source).toBe("codex-session-log");
		expect(limits?.primary?.usedPercent).toBe(64);
		expect(limits?.secondary?.usedPercent).toBe(21);
	});

	it("sends nothing that is not shaped like a token", async () => {
		writeAuth({
			tokens: { access_token: "line one\nline two", account_id: "acc\r\nX: y" },
		});
		expect(await readCodexAuth(home)).toBeNull();
		writeAuth({ tokens: { access_token: "aaa.bbb.ccc", account_id: "acc\r\nX: y" } });
		expect(await readCodexAuth(home)).toEqual({
			accessToken: "aaa.bbb.ccc",
			accountId: undefined,
		});
	});

	it("does not call the API for an API-key Codex login", async () => {
		writeAuth({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x", tokens: null });
		expect(await readCodexAuth(home)).toBeNull();
		const fetchImpl = vi.fn();
		const limits = await fetchCodexRateLimits({
			codexHome: home,
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: NOW,
		});
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(limits).toBeNull();
	});
});
