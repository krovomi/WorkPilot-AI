/**
 * @vitest-environment node
 *
 * The AI accounts saved for the app (ai-accounts.ts): keys encrypted on disk,
 * never in a view, a key behind the mask kept, a default that only names an
 * account of its own provider, and the main key back when the default goes.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MASKED_SECRET } from "../../../shared/constants/secrets";
import { accountProviderOf } from "../../../shared/types/ai-accounts";
import { isWindows } from "../../platform";

vi.mock("electron", () => ({ app: { getPath: () => "/unused" } }));
vi.mock("../../secret-storage", () => ({
	encryptSecret: (value: string) => `enc:${Buffer.from(value).toString("base64")}`,
	decryptSecret: (stored: string) =>
		stored.startsWith("enc:") ? Buffer.from(stored.slice(4), "base64").toString("utf-8") : stored,
}));
vi.mock("../../app-logger", () => ({ appLog: { warn: vi.fn() } }));

import { defaultAccountKey, hasMainKey, settingsApiKey } from "../ai-account-key";
import {
	AiAccountStore,
	MAX_AI_ACCOUNTS,
	aiAccountStore,
	isAiAccountProvider,
	setAiAccountStoreForTests,
} from "../ai-accounts";

const KEY = "sk-test-0000";

let dir: string;
let file: string;
let store: AiAccountStore;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "ai-accounts-"));
	file = path.join(dir, "config", "ai-accounts.json");
	store = new AiAccountStore(file);
});

afterEach(() => {
	setAiAccountStoreForTests(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("providers", () => {
	it("knows the API-key providers and resolves their aliases", () => {
		expect(isAiAccountProvider("openai")).toBe(true);
		expect(isAiAccountProvider("openrouter")).toBe(true);
		expect(isAiAccountProvider("copilot")).toBe(false);
		expect(isAiAccountProvider("anthropic")).toBe(false);
		expect(isAiAccountProvider(42)).toBe(false);
		expect(accountProviderOf(" Gemini ")).toBe("google");
		expect(accountProviderOf("ollama")).toBeUndefined();
		expect(accountProviderOf(undefined)).toBeUndefined();
	});
});

describe("AiAccountStore", () => {
	it("stores the key encrypted in a 0600 file and never shows it", () => {
		const view = store.save({ provider: "openai", name: " Perso ", apiKey: KEY });
		expect(view).toMatchObject({ provider: "openai", name: "Perso", hasKey: true });
		expect(view).not.toHaveProperty("apiKey");
		expect(JSON.stringify(store.list())).not.toContain(KEY);
		const raw = readFileSync(file, "utf-8");
		expect(raw).not.toContain(KEY);
		expect(raw).toContain("enc:");
		if (!isWindows()) expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(store.keyOf(view.id)).toBe(KEY);
	});

	it("refuses an unknown provider, a missing name or key, and a key with spaces", () => {
		expect(() => store.save({ provider: "anthropic", name: "x", apiKey: KEY })).toThrow("Invalid provider");
		expect(() => store.save({ provider: "openai", name: "  ", apiKey: KEY })).toThrow("A name is required");
		expect(() => store.save({ provider: "openai", name: "x" })).toThrow("A key is required");
		expect(() => store.save({ provider: "openai", name: "x", apiKey: "sk 1" })).toThrow("Invalid key");
		expect(() => store.save({ provider: "openai", name: "x", apiKey: "k".repeat(5000) })).toThrow(
			"Key too long",
		);
	});

	it("keeps the saved key behind the mask, and replaces it when one is typed", () => {
		const created = store.save({ provider: "mistral", name: "Work", apiKey: KEY });
		store.save({ id: created.id, provider: "mistral", name: "Work 2", apiKey: MASKED_SECRET });
		expect(store.keyOf(created.id)).toBe(KEY);
		expect(store.get(created.id)?.name).toBe("Work 2");
		store.save({ id: created.id, provider: "mistral", name: "Work 2", apiKey: "sk-test-1111" });
		expect(store.keyOf(created.id)).toBe("sk-test-1111");
	});

	it("never moves an account to another provider", () => {
		const created = store.save({ provider: "mistral", name: "Work", apiKey: KEY });
		expect(() => store.save({ id: created.id, provider: "openai", name: "Work" })).toThrow(
			"Invalid provider",
		);
		expect(() => store.save({ id: "nope", provider: "mistral", name: "Work" })).toThrow(
			"Account not found",
		);
	});

	it("names a default only among the provider's own accounts", () => {
		const openai = store.save({ provider: "openai", name: "A", apiKey: KEY });
		const mistral = store.save({ provider: "mistral", name: "B", apiKey: KEY });
		expect(() => store.setDefault("openai", mistral.id)).toThrow("Account not found");
		expect(() => store.setDefault("anthropic", openai.id)).toThrow("Invalid provider");
		store.setDefault("openai", openai.id);
		expect(store.defaults()).toEqual({ openai: openai.id });
		expect(store.defaultOf("openai")).toEqual({ account: store.get(openai.id), apiKey: KEY });
		store.setDefault("openai", null);
		expect(store.defaultOf("openai")).toBeUndefined();
	});

	it("ignores a default on disk that names another provider's account", () => {
		const mistral = store.save({ provider: "mistral", name: "B", apiKey: KEY });
		const content = JSON.parse(readFileSync(file, "utf-8"));
		writeFileSync(file, JSON.stringify({ ...content, defaults: { openai: mistral.id } }));
		expect(store.defaults()).toEqual({});
		expect(store.defaultOf("openai")).toBeUndefined();
	});

	it("goes back to the main key when the default account is deleted", () => {
		const a = store.save({ provider: "grok", name: "A", apiKey: KEY });
		store.setDefault("grok", a.id);
		expect(store.delete(a.id)).toBe(true);
		expect(store.defaults()).toEqual({});
		expect(store.delete(a.id)).toBe(false);
	});

	it("reads a missing or broken file as empty", () => {
		expect(store.list()).toEqual([]);
		store.save({ provider: "openai", name: "A", apiKey: KEY });
		writeFileSync(file, "{ not json");
		expect(store.list()).toEqual([]);
		expect(store.defaults()).toEqual({});
	});

	it("caps the number of accounts", () => {
		const accounts = Array.from({ length: MAX_AI_ACCOUNTS }, (_, index) => ({
			id: `id-${index}`,
			provider: "openai",
			name: `A${index}`,
			apiKey: "enc:eA==",
			createdAt: "2026-11-27T00:00:00.000Z",
		}));
		store.save({ provider: "openai", name: "first", apiKey: KEY });
		writeFileSync(file, JSON.stringify({ version: 1, accounts, defaults: {} }));
		expect(() => store.save({ provider: "openai", name: "one more", apiKey: KEY })).toThrow(
			"Too many accounts",
		);
	});
});

describe("an AWS account (key pair and region)", () => {
	const ID = "AKIATEST0000";
	const SECRET = "secret-test-0000";

	it("needs its secret, stores it encrypted and never shows it", () => {
		expect(() => store.save({ provider: "aws", name: "x", apiKey: ID })).toThrow("A secret key is required");
		const view = store.save({ provider: "aws", name: "Prod", apiKey: ID, secretKey: SECRET });
		expect(view).toMatchObject({ provider: "aws", hasKey: true, hasSecret: true, region: "us-east-1" });
		expect(view).not.toHaveProperty("secretKey");
		expect(JSON.stringify(store.list())).not.toContain(SECRET);
		expect(readFileSync(file, "utf-8")).not.toContain(SECRET);
		expect(store.pairOf(view.id)).toEqual({ secretKey: SECRET, region: "us-east-1" });
		expect(store.pairOf("nope")).toBeUndefined();
	});

	it("keeps the secret and region behind the mask, and replaces them when typed", () => {
		const created = store.save({
			provider: "aws",
			name: "Prod",
			apiKey: ID,
			secretKey: SECRET,
			region: " EU-West-3 ",
		});
		expect(created.region).toBe("eu-west-3");
		store.save({ id: created.id, provider: "aws", name: "Prod", apiKey: MASKED_SECRET, secretKey: MASKED_SECRET });
		expect(store.pairOf(created.id)).toEqual({ secretKey: SECRET, region: "eu-west-3" });
		store.save({ id: created.id, provider: "aws", name: "Prod", secretKey: "secret-1111", region: "us-west-2" });
		expect(store.pairOf(created.id)).toEqual({ secretKey: "secret-1111", region: "us-west-2" });
		expect(store.keyOf(created.id)).toBe(ID);
	});

	it("refuses a region that is not one", () => {
		expect(() =>
			store.save({ provider: "aws", name: "x", apiKey: ID, secretKey: SECRET, region: "eu west" }),
		).toThrow("Invalid region");
		expect(() => store.save({ provider: "aws", name: "x", apiKey: ID, secretKey: "a b" })).toThrow("Invalid key");
	});

	it("is not a default until both halves are set, and reads an account without a secret as keyless", () => {
		const created = store.save({ provider: "aws", name: "Prod", apiKey: ID, secretKey: SECRET });
		const content = JSON.parse(readFileSync(file, "utf-8"));
		delete content.accounts[0].secretKey;
		writeFileSync(file, JSON.stringify(content));
		expect(store.get(created.id)).toMatchObject({ hasKey: false, hasSecret: false });
		expect(store.pairOf(created.id)).toBeUndefined();
		expect(() => store.setDefault("aws", created.id)).toThrow();
	});

	it("ignores a secret or region sent for a single-key provider", () => {
		const view = store.save({ provider: "cursor", name: "C", apiKey: KEY, secretKey: SECRET, region: "eu-west-3" });
		expect(view).not.toHaveProperty("region");
		expect(view).not.toHaveProperty("hasSecret");
		expect(readFileSync(file, "utf-8")).not.toContain("eu-west-3");
		expect(store.pairOf(view.id)).toBeUndefined();
	});

	it("reads a stored pair without a region as us-east-1", () => {
		const created = store.save({ provider: "aws", name: "Prod", apiKey: ID, secretKey: SECRET });
		const content = JSON.parse(readFileSync(file, "utf-8"));
		delete content.accounts[0].region;
		writeFileSync(file, JSON.stringify(content));
		expect(store.get(created.id)?.region).toBe("us-east-1");
		expect(store.pairOf(created.id)).toEqual({ secretKey: SECRET, region: "us-east-1" });
	});

	it("reads a stored account with a broken region as no account", () => {
		store.save({ provider: "aws", name: "Prod", apiKey: ID, secretKey: SECRET });
		const content = JSON.parse(readFileSync(file, "utf-8"));
		content.accounts[0].region = "nowhere";
		writeFileSync(file, JSON.stringify(content));
		expect(store.list()).toEqual([]);
	});
});

describe("the key a provider runs on", () => {
	it("is the default account's, aliases included, else none", () => {
		setAiAccountStoreForTests(store);
		expect(aiAccountStore()).toBe(store);
		expect(defaultAccountKey("google")).toBeUndefined();
		const google = store.save({ provider: "google", name: "G", apiKey: KEY });
		store.setDefault("google", google.id);
		expect(defaultAccountKey("gemini")).toBe(KEY);
		expect(defaultAccountKey("copilot")).toBeUndefined();
		expect(defaultAccountKey(null)).toBeUndefined();
	});

	it("leaves the provider on its main key when the store cannot be read", () => {
		setAiAccountStoreForTests({
			defaultOf: () => {
				throw new Error("disk");
			},
		} as unknown as AiAccountStore);
		expect(defaultAccountKey("openai")).toBeUndefined();
	});

	it("reads the main key from the provider's Settings fields, in order", () => {
		expect(settingsApiKey("google", { globalGoogleApiKey: "b", globalGoogleDeepMindApiKey: " a " })).toBe("a");
		expect(settingsApiKey("mistral", { globalMistralApiKey: "  " })).toBe("");
		expect(settingsApiKey("unknown", { globalMistralApiKey: "x" })).toBe("");
		expect(hasMainKey("mistral", { globalMistralApiKey: "x" })).toBe(true);
		expect(hasMainKey("mistral", undefined)).toBe(false);
	});
});
