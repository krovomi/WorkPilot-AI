/**
 * @vitest-environment node
 *
 * The accounts an agent process is told it runs on (account-attribution.ts):
 * the default accounts with a key and the Claude sign-in, as ids only.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/unused" } }));
vi.mock("../../secret-storage", () => ({
	encryptSecret: (value: string) => `enc:${value}`,
	decryptSecret: (stored: string) => stored.slice(4),
}));

import { AI_ACCOUNTS_ENV, processAccounts, processAccountsEnv } from "../account-attribution";
import { AiAccountStore, setAiAccountStoreForTests } from "../ai-accounts";

let dir: string;
let store: AiAccountStore;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "account-attribution-"));
	store = new AiAccountStore(path.join(dir, "ai-accounts.json"));
	setAiAccountStoreForTests(store);
});

afterEach(() => {
	setAiAccountStoreForTests(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("processAccounts", () => {
	it("names each provider's default account and the Claude sign-in, never a key", () => {
		const work = store.save({ provider: "openai", name: "Work", apiKey: "sk-test-0000" });
		store.save({ provider: "openai", name: "Other", apiKey: "sk-test-1111" });
		const mistral = store.save({ provider: "mistral", name: "M", apiKey: "mk-test-0000" });
		store.setDefault("openai", work.id);
		store.setDefault("mistral", mistral.id);

		const accounts = processAccounts("work-profile");
		expect(accounts).toEqual({ openai: work.id, mistral: mistral.id, claude: "claude:work-profile" });
		const env = processAccountsEnv("work-profile");
		expect(JSON.parse(env[AI_ACCOUNTS_ENV])).toEqual(accounts);
		expect(env[AI_ACCOUNTS_ENV]).not.toContain("sk-test");
	});

	it("gives nothing when no account is chosen", () => {
		store.save({ provider: "openai", name: "Work", apiKey: "sk-test-0000" });
		expect(processAccounts()).toEqual({});
		expect(processAccountsEnv(null)).toEqual({});
	});

	it("leaves out a Claude profile id that is not a plain label", () => {
		expect(processAccounts("a b/c")).toEqual({});
	});

	it("names no Claude account for a process that does not run on Claude", () => {
		expect(processAccounts("work", false)).toEqual({});
		expect(processAccountsEnv("work", false)).toEqual({});
	});

	it("leaves out a default whose id a hand edit made odd", () => {
		writeFileSync(
			path.join(dir, "ai-accounts.json"),
			JSON.stringify({
				accounts: [{ id: "a b", provider: "openai", name: "Odd", apiKey: "enc:sk-test-0000", createdAt: "" }],
				defaults: { openai: "a b" },
			}),
			"utf-8",
		);
		expect(store.defaults()).toEqual({ openai: "a b" });
		expect(processAccounts()).toEqual({});
	});

	it("names the accounts a task pinned over the defaults", () => {
		const work = store.save({ provider: "openai", name: "Work", apiKey: "sk-test-0000" });
		store.setDefault("openai", work.id);
		expect(processAccounts("default-profile", true, { openai: "client-acc", claude: "client-profile" })).toEqual({
			openai: "client-acc",
			claude: "claude:client-profile",
		});
		expect(processAccounts(null, true, { mistral: "bad id" })).toEqual({ openai: work.id });
		expect(processAccountsEnv(null, false, { claude: "client-profile" })).toEqual({
			[AI_ACCOUNTS_ENV]: JSON.stringify({ openai: work.id }),
		});
	});

	it("still starts the process when the store cannot be read", () => {
		setAiAccountStoreForTests({
			list: () => {
				throw new Error("unreadable");
			},
		} as unknown as AiAccountStore);
		expect(processAccounts("p1")).toEqual({ claude: "claude:p1" });
	});
});
