/**
 * @vitest-environment node
 *
 * Accounts with their plan (account-plans.ts): Claude's profiles with the
 * plan they were seen on, API-key accounts on "api", never a key.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claude = vi.hoisted(() => ({ settings: { profiles: [] as unknown[], activeProfileId: "" } }));

vi.mock("electron", () => ({ app: { getPath: () => "/unused" } }));
vi.mock("../../secret-storage", () => ({
	encryptSecret: (value: string) => `enc:${value}`,
	decryptSecret: (stored: string) => stored.slice(4),
}));
vi.mock("../../claude-profile-manager", () => ({
	getClaudeProfileManager: () => ({ getSettings: () => claude.settings }),
}));

import { accountsWithPlan, claudePlanOf, hasClaudeOrganizationPlan } from "../account-plans";
import { AiAccountStore, setAiAccountStoreForTests } from "../ai-accounts";

let dir: string;
let store: AiAccountStore;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "account-plans-"));
	store = new AiAccountStore(path.join(dir, "ai-accounts.json"));
	setAiAccountStoreForTests(store);
	claude.settings = {
		profiles: [
			{ id: "p1", name: "Me", subscriptionType: "Max", isAuthenticated: true },
			{ id: "p2", name: "Org", subscriptionType: "team", isAuthenticated: false },
			{ id: "p3", name: "Old" },
		],
		activeProfileId: "p1",
	};
});

afterEach(() => {
	setAiAccountStoreForTests(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("account plans", () => {
	it("reads a Claude subscription type as a plan", () => {
		expect(claudePlanOf(" Enterprise ")).toBe("enterprise");
		expect(claudePlanOf("free")).toBe("unknown");
		expect(claudePlanOf(undefined)).toBe("unknown");
	});

	it("lists Claude's profiles with their plan and the default", () => {
		expect(accountsWithPlan("Claude")).toEqual([
			{ id: "p1", provider: "anthropic", name: "Me", plan: "max", isDefault: true, signedIn: true },
			{ id: "p2", provider: "anthropic", name: "Org", plan: "team", isDefault: false, signedIn: false },
			{ id: "p3", provider: "anthropic", name: "Old", plan: "unknown", isDefault: false, signedIn: true },
		]);
	});

	it("needs a signed-in Team or Enterprise Claude account", () => {
		expect(hasClaudeOrganizationPlan()).toBe(false);
		(claude.settings.profiles[1] as { isAuthenticated: boolean }).isAuthenticated = true;
		expect(hasClaudeOrganizationPlan()).toBe(true);
	});

	it("lists API-key accounts on the api plan, without their key", () => {
		const a = store.save({ provider: "google", name: "G", apiKey: "sk-test-0000" });
		store.save({ provider: "openai", name: "O", apiKey: "sk-test-1111" });
		store.setDefault("google", a.id);
		const listed = accountsWithPlan("gemini");
		expect(listed).toEqual([
			{ id: a.id, provider: "google", name: "G", plan: "api", isDefault: true, signedIn: true },
		]);
		expect(JSON.stringify(listed)).not.toContain("sk-test");
		expect(accountsWithPlan("copilot")).toEqual([]);
	});
});
