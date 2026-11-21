/**
 * The Claude plan an OAuth account has now, asked to Anthropic: only plan
 * identifiers come back, the token goes to one fixed URL, and anything not
 * understood leaves the stored plan in place.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
	credentials: {
		token: "tok-test-0000" as string | null,
		expiresAt: null as number | null,
	},
	throws: false,
}));

vi.mock("../credential-utils", () => ({
	getFullCredentialsFromKeychain: vi.fn(() => {
		if (world.throws) throw new Error("keychain locked");
		return { ...world.credentials };
	}),
}));

import {
	fetchClaudeAccountPlan,
	parseClaudeAccountPlan,
	readClaudeAccountPlan,
} from "../claude-account-plan";
import { getFullCredentialsFromKeychain } from "../credential-utils";

const MAX_PROFILE = {
	account: { has_claude_max: true, has_claude_pro: false },
	organization: {
		organization_type: "claude_max",
		rate_limit_tier: "default_claude_max_20x",
	},
};

function answer(body: unknown, init: { ok?: boolean; raw?: string } = {}) {
	return vi.fn(async () => ({
		ok: init.ok ?? true,
		text: async () => init.raw ?? JSON.stringify(body),
	})) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

beforeEach(() => {
	world.credentials = { token: "tok-test-0000", expiresAt: null };
	world.throws = false;
	vi.clearAllMocks();
});

describe("parseClaudeAccountPlan", () => {
	it("reads the organization type and its rate limit tier", () => {
		expect(parseClaudeAccountPlan(MAX_PROFILE)).toEqual({
			subscriptionType: "max",
			rateLimitTier: "default_claude_max_20x",
		});
		expect(
			parseClaudeAccountPlan({ organization: { organization_type: "claude_pro" } }),
		).toEqual({ subscriptionType: "pro" });
		expect(
			parseClaudeAccountPlan({ organization: { organization_type: "CLAUDE_TEAM" } }),
		).toEqual({ subscriptionType: "team" });
		expect(
			parseClaudeAccountPlan({
				organization: { organization_type: "claude_enterprise" },
			}),
		).toEqual({ subscriptionType: "enterprise" });
	});

	it("falls back to the account's flags", () => {
		expect(parseClaudeAccountPlan({ account: { has_claude_max: true } })).toEqual({
			subscriptionType: "max",
		});
		expect(
			parseClaudeAccountPlan({
				account: { has_claude_max: false, has_claude_pro: true },
				organization: { organization_type: "something_else" },
			}),
		).toEqual({ subscriptionType: "pro" });
	});

	it("names no plan it does not understand", () => {
		expect(parseClaudeAccountPlan(null)).toBeUndefined();
		expect(parseClaudeAccountPlan([MAX_PROFILE])).toBeUndefined();
		expect(parseClaudeAccountPlan({ account: { has_claude_max: "yes" } })).toBeUndefined();
		expect(
			parseClaudeAccountPlan({ organization: { organization_type: 42 } }),
		).toBeUndefined();
		expect(parseClaudeAccountPlan({ account: [] })).toBeUndefined();
	});

	it("refuses a tier that is not an identifier", () => {
		expect(
			parseClaudeAccountPlan({
				organization: {
					organization_type: "claude_max",
					rate_limit_tier: "max 20x; drop",
				},
			}),
		).toEqual({ subscriptionType: "max" });
	});
});

describe("fetchClaudeAccountPlan", () => {
	it("asks the OAuth profile endpoint with the token and no redirect", async () => {
		const fetchImpl = answer(MAX_PROFILE);
		await expect(fetchClaudeAccountPlan("tok-test-0000", fetchImpl)).resolves.toEqual({
			subscriptionType: "max",
			rateLimitTier: "default_claude_max_20x",
		});
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.anthropic.com/api/oauth/profile");
		expect(init.redirect).toBe("error");
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer tok-test-0000",
		);
		expect((init.headers as Record<string, string>)["anthropic-beta"]).toBe(
			"oauth-2025-04-20",
		);
	});

	it("says nothing on an error answer, an oversized or unreadable body, or a failure", async () => {
		await expect(
			fetchClaudeAccountPlan("t", answer(MAX_PROFILE, { ok: false })),
		).resolves.toBeUndefined();
		await expect(
			fetchClaudeAccountPlan("t", answer(null, { raw: "x".repeat(100_001) })),
		).resolves.toBeUndefined();
		await expect(
			fetchClaudeAccountPlan("t", answer(null, { raw: "<html>" })),
		).resolves.toBeUndefined();
		const failing = vi.fn(async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		await expect(fetchClaudeAccountPlan("t", failing)).resolves.toBeUndefined();
	});
});

describe("readClaudeAccountPlan", () => {
	it("asks with the token of the profile's config directory", async () => {
		const fetchImpl = answer(MAX_PROFILE);
		world.credentials.expiresAt = Date.now() + 60_000;
		await expect(readClaudeAccountPlan("/cfg", fetchImpl)).resolves.toEqual({
			subscriptionType: "max",
			rateLimitTier: "default_claude_max_20x",
		});
		expect(getFullCredentialsFromKeychain).toHaveBeenCalledWith("/cfg");
	});

	it("does not ask without a usable token", async () => {
		const fetchImpl = answer(MAX_PROFILE);
		world.credentials.token = null;
		await expect(readClaudeAccountPlan("/cfg", fetchImpl)).resolves.toBeUndefined();
		world.credentials = { token: "tok-test-0000", expiresAt: Date.now() - 1 };
		await expect(readClaudeAccountPlan("/cfg", fetchImpl)).resolves.toBeUndefined();
		world.throws = true;
		await expect(readClaudeAccountPlan("/cfg", fetchImpl)).resolves.toBeUndefined();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
