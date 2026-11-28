import { describe, expect, it } from "vitest";
import type { ClaudeProfile } from "../../../../shared/types/agent";
import type { APIProfile } from "../../../../shared/types/profile";
import { buildFailoverAccounts, isAccountExcluded, orderFailoverAccounts } from "../failover-accounts";

const claude = (id: string, isAuthenticated = true) =>
	({ id, name: `Claude ${id}`, email: `${id}@example.com`, isAuthenticated }) as ClaudeProfile;
const api = (id: string, baseUrl: string, apiKey?: string) => ({ id, name: `API ${id}`, baseUrl, apiKey }) as APIProfile;

const PROVIDERS = [
	{ name: "anthropic", label: "Anthropic" },
	{ name: "openai", label: "OpenAI" },
	{ name: "copilot", label: "GitHub Copilot" },
	{ name: "ollama", label: "Ollama" },
	{ name: "mistral", label: "Mistral" },
];

describe("buildFailoverAccounts", () => {
	it("lists the Claude accounts, the API profiles, then the other connected providers", () => {
		const accounts = buildFailoverAccounts({
			claudeProfiles: [claude("a"), claude("b", false)],
			activeClaudeProfileId: "a",
			apiProfiles: [api("o", "https://api.openai.com/v1", "k"), api("none", "https://api.mistral.ai/v1")],
			activeApiProfileId: null,
			providers: PROVIDERS,
			connected: { anthropic: true, openai: true, copilot: true, ollama: true, mistral: false },
			usage: new Map([["a", { sessionPercent: 30, weeklyPercent: 5 }]]),
			copilotLogin: "octo",
		});
		expect(accounts).toEqual([
			{
				id: "oauth-a",
				kind: "oauth",
				provider: "anthropic",
				label: "Claude a",
				detail: "a@example.com",
				isActive: true,
				sessionPercent: 30,
				weeklyPercent: 5,
			},
			{ id: "api-o", kind: "api", provider: "openai", label: "API o", detail: "https://api.openai.com/v1", isActive: false },
			{ id: "provider-copilot", kind: "provider", provider: "copilot", label: "GitHub Copilot", detail: "@octo", isActive: false },
			{ id: "provider-ollama", kind: "provider", provider: "ollama", label: "Ollama", detail: undefined, isActive: false },
		]);
	});

	it("marks the active API profile instead of the Claude account, and names an unknown provider by its id", () => {
		const accounts = buildFailoverAccounts({
			claudeProfiles: [claude("a")],
			activeClaudeProfileId: "a",
			apiProfiles: [api("p", "https://proxy.example.internal", "k")],
			activeApiProfileId: "p",
			providers: [{ name: "copilot", label: "GitHub Copilot" }],
			connected: { copilot: true, "brand-new": true },
		});
		expect(accounts.map((a) => [a.id, a.isActive])).toEqual([
			["oauth-a", false],
			["api-p", true],
			["provider-copilot", false],
		]);
		expect(accounts[2].detail).toBeUndefined();
	});
});

describe("buildFailoverAccounts with several accounts per provider", () => {
	const view = (id: string, provider: string, hasKey = true) => ({
		id,
		provider,
		name: `Account ${id}`,
		hasKey,
		createdAt: "2026-11-28T00:00:00.000Z",
	});

	it("lists each AI account with a key, marks the default, and drops the provider's generic entry", () => {
		const accounts = buildFailoverAccounts({
			claudeProfiles: [],
			apiProfiles: [],
			providers: PROVIDERS,
			connected: { openai: true, mistral: true },
			aiAccounts: [view("o1", "openai"), view("o2", "openai"), view("nokey", "openai", false)],
			aiAccountDefaults: { openai: "o2" },
		});
		expect(accounts.map((a) => [a.id, a.kind, a.provider, a.label, a.isActive])).toEqual([
			["account-o1", "account", "openai", "Account o1", false],
			["account-o2", "account", "openai", "Account o2", true],
			["provider-mistral", "provider", "mistral", "Mistral", false],
		]);
	});

	it("lists the CLI sign-in accounts that are signed in, a Codex one under OpenAI", () => {
		const login = (id: string, provider: string, signedIn = true) => ({
			...view(id, provider, false),
			kind: "login" as const,
			signedIn,
		});
		const accounts = buildFailoverAccounts({
			claudeProfiles: [],
			apiProfiles: [],
			providers: PROVIDERS,
			connected: { openai: true, copilot: true },
			aiAccounts: [login("g1", "copilot"), login("g2", "copilot", false), login("c1", "codex")],
			aiAccountDefaults: { copilot: "g1", codex: "c1" },
		});
		expect(accounts.map((a) => [a.id, a.provider, a.isActive])).toEqual([
			["account-g1", "copilot", true],
			["account-c1", "openai", true],
			// The OpenAI key stays an entry of its own; Copilot's is its default sign-in.
			["provider-openai", "openai", false],
		]);
	});
});

describe("orderFailoverAccounts", () => {
	it("follows the saved order, older bare names included, and puts new accounts after", () => {
		const accounts = buildFailoverAccounts({
			claudeProfiles: [claude("a"), claude("b")],
			apiProfiles: [],
			providers: PROVIDERS,
			connected: { copilot: true, ollama: true },
		});
		expect(orderFailoverAccounts(accounts, ["copilot", "oauth-b", "bad id!", "provider-copilot"]).map((a) => a.id)).toEqual([
			"provider-copilot",
			"oauth-b",
			"oauth-a",
			"provider-ollama",
		]);
	});
});

describe("isAccountExcluded", () => {
	it("matches by id, and a provider entry by its provider", () => {
		const [account] = buildFailoverAccounts({
			claudeProfiles: [],
			apiProfiles: [],
			providers: PROVIDERS,
			connected: { copilot: true },
		});
		expect(isAccountExcluded(account, ["copilot"])).toBe(true);
		expect(isAccountExcluded(account, ["provider-copilot"])).toBe(true);
		expect(isAccountExcluded(account, ["oauth-copilot"])).toBe(false);
	});
});
