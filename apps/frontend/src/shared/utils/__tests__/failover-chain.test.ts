import { describe, expect, it } from "vitest";
import {
	apiProfileProvider,
	type FailoverCandidate,
	failoverEntryId,
	isFailoverEntryExcluded,
	MAX_FAILOVER_ENTRIES,
	normalizeFailoverOrder,
	parseFailoverEntry,
	pickNextFailover,
	sanitizeAutoSwitchUpdate,
} from "../failover-chain";

const candidate = (id: string, provider: string): FailoverCandidate => {
	const entry = parseFailoverEntry(id);
	if (!entry) throw new Error(`not an entry: ${id}`);
	return { ...entry, provider };
};

describe("parseFailoverEntry", () => {
	it("reads the four kinds of entry", () => {
		expect(parseFailoverEntry("account-8f1c2d3e-aaaa-4bbb-8ccc-1234567890ab")).toEqual({
			id: "account-8f1c2d3e-aaaa-4bbb-8ccc-1234567890ab",
			kind: "account",
			key: "8f1c2d3e-aaaa-4bbb-8ccc-1234567890ab",
		});
		expect(parseFailoverEntry("oauth-work")).toEqual({ id: "oauth-work", kind: "oauth", key: "work" });
		expect(parseFailoverEntry("api-profile_1")).toEqual({ id: "api-profile_1", kind: "api", key: "profile_1" });
		expect(parseFailoverEntry("provider-copilot")).toEqual({
			id: "provider-copilot",
			kind: "provider",
			key: "copilot",
		});
	});

	it("reads a provider saved before the chain had kinds", () => {
		expect(parseFailoverEntry("copilot")).toEqual({ id: "provider-copilot", kind: "provider", key: "copilot" });
	});

	it("refuses anything else", () => {
		for (const id of ["", "oauth-", "account-", "account-../x", "oauth-../x", "api- spaced", "Copilot", "x", "provider-/etc", "gemini-", "a--b"]) {
			expect(parseFailoverEntry(id)).toBeNull();
		}
	});
});

describe("normalizeFailoverOrder", () => {
	it("keeps entries once, in order, and drops unknown ids", () => {
		expect(normalizeFailoverOrder(["oauth-a", "nope!", "copilot", "provider-copilot", "oauth-a"])).toEqual([
			"oauth-a",
			"provider-copilot",
		]);
	});

	it("refuses a value that is not a bounded list of text", () => {
		expect(normalizeFailoverOrder("oauth-a")).toBeNull();
		expect(normalizeFailoverOrder(["oauth-a", 3])).toBeNull();
		expect(normalizeFailoverOrder(Array.from({ length: MAX_FAILOVER_ENTRIES + 1 }, (_, i) => `oauth-${i}`))).toBeNull();
	});
});

describe("apiProfileProvider", () => {
	it("names the provider of a known endpoint", () => {
		expect(apiProfileProvider({ baseUrl: "https://api.openai.com/v1" })).toBe("openai");
	});

	it("takes an unknown or missing endpoint for Anthropic", () => {
		expect(apiProfileProvider({ baseUrl: "https://proxy.example.internal" })).toBe("anthropic");
		expect(apiProfileProvider({})).toBe("anthropic");
	});
});

describe("isFailoverEntryExcluded", () => {
	it("matches an entry by id, and a provider entry by its older bare name", () => {
		expect(isFailoverEntryExcluded(candidate("oauth-a", "anthropic"), ["oauth-a"])).toBe(true);
		expect(isFailoverEntryExcluded(candidate("provider-copilot", "copilot"), ["copilot"])).toBe(true);
		expect(isFailoverEntryExcluded(candidate("api-copilot", "openai"), ["copilot"])).toBe(false);
	});
});

describe("pickNextFailover", () => {
	const chain = [
		candidate("oauth-perso", "anthropic"),
		candidate("oauth-work", "anthropic"),
		candidate("provider-anthropic", "anthropic"),
		candidate("provider-copilot", "copilot"),
		candidate("api-mistral", "mistral"),
	];
	const base = { tried: new Set<string>(), excluded: [], isUsable: () => true };

	it("moves a Claude task to the next Claude account first", () => {
		expect(pickNextFailover(chain, { ...base, provider: "anthropic", currentEntryId: "oauth-perso" })?.id).toBe(
			"oauth-work",
		);
	});

	it("skips the generic entry of the provider the task stopped on", () => {
		expect(
			pickNextFailover(chain, {
				...base,
				provider: "claude",
				currentEntryId: "oauth-perso",
				tried: new Set(["oauth-work"]),
			})?.id,
		).toBe("provider-copilot");
	});

	it("skips excluded and unusable entries", () => {
		expect(
			pickNextFailover(chain, {
				...base,
				provider: "copilot",
				excluded: ["oauth-perso", "anthropic"],
				isUsable: (c) => c.id !== "oauth-work",
			})?.id,
		).toBe("api-mistral");
	});

	it("answers null when nothing is left", () => {
		expect(pickNextFailover(chain, { ...base, provider: "mistral", isUsable: () => false })).toBeNull();
	});

	it("tries the other accounts of the stopped provider before another provider", () => {
		const accounts = [
			candidate("oauth-perso", "anthropic"),
			candidate("account-m1", "mistral"),
			candidate("account-o1", "openai"),
			candidate("provider-openai", "openai"),
			candidate("account-o2", "openai"),
		];
		const context = { ...base, provider: "openai", currentEntryId: "account-o1" };
		expect(pickNextFailover(accounts, context)?.id).toBe("account-o2");
		// Off: the chain's own order, whatever the provider.
		expect(pickNextFailover(accounts, { ...context, sameProviderFirst: false })?.id).toBe("oauth-perso");
		// No other account of the provider left: the chain goes on to the others.
		expect(pickNextFailover(accounts, { ...context, tried: new Set(["account-o2"]) })?.id).toBe("oauth-perso");
	});

	it("builds ids from a kind and a key", () => {
		expect(failoverEntryId("api", "x")).toBe("api-x");
	});
});

describe("sanitizeAutoSwitchUpdate", () => {
	it("keeps known switches and whole thresholds from 50 to 99", () => {
		expect(
			sanitizeAutoSwitchUpdate({
				enabled: true,
				proactiveSwapEnabled: false,
				autoSwitchOnRateLimit: "yes",
				sessionThreshold: 90,
				weeklyThreshold: 100,
				usageCheckInterval: 1,
				extra: true,
			}),
		).toEqual({ enabled: true, proactiveSwapEnabled: false, sessionThreshold: 90 });
		expect(sanitizeAutoSwitchUpdate({ weeklyThreshold: 49.5, autoSwitchOnAuthFailure: true })).toEqual({
			autoSwitchOnAuthFailure: true,
		});
		expect(sanitizeAutoSwitchUpdate({ sameProviderFirst: false })).toEqual({ sameProviderFirst: false });
		expect(sanitizeAutoSwitchUpdate({ sameProviderFirst: "no" })).toBeNull();
	});

	it("refuses a value with nothing valid in it", () => {
		expect(sanitizeAutoSwitchUpdate(null)).toBeNull();
		expect(sanitizeAutoSwitchUpdate([true])).toBeNull();
		expect(sanitizeAutoSwitchUpdate({ sessionThreshold: 10 })).toBeNull();
	});
});
