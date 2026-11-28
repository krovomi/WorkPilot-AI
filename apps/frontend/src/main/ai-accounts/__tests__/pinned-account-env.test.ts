/**
 * @vitest-environment node
 *
 * The account a project or a card pins (pinned-account-env.ts): its key goes
 * to the provider's own endpoint, only for an account of that provider; a pin
 * that cannot be served leaves the environment as the credential manager built it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/unused" } }));
vi.mock("../../secret-storage", () => ({
	encryptSecret: (value: string) => `enc:${Buffer.from(value).toString("base64")}`,
	decryptSecret: (stored: string) =>
		stored.startsWith("enc:") ? Buffer.from(stored.slice(4), "base64").toString("utf-8") : stored,
}));
const warn = vi.fn();
vi.mock("../../app-logger", () => ({ appLog: { warn: (...args: unknown[]) => warn(...args) } }));

import { AiAccountStore, setAiAccountStoreForTests } from "../ai-accounts";
import { applyPinnedAccount, pinnedAccountKey, servedAccountPins } from "../pinned-account-env";

const CLIENT_KEY = "sk-test-client-0000";
const PERSO_KEY = "sk-test-perso-0000";

let dir: string;
let store: AiAccountStore;

beforeEach(() => {
	warn.mockClear();
	dir = mkdtempSync(path.join(tmpdir(), "ai-pins-"));
	store = new AiAccountStore(path.join(dir, "config", "ai-accounts.json"));
	setAiAccountStoreForTests(store);
});

afterEach(() => {
	setAiAccountStoreForTests(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("applyPinnedAccount", () => {
	it("puts the pinned account's key in place of the default and drops a profile's endpoint", () => {
		const client = store.save({ provider: "mistral", name: "Client", apiKey: CLIENT_KEY });
		const env: Record<string, string> = {
			MISTRAL_API_KEY: PERSO_KEY,
			MISTRAL_BASE_URL: "https://proxy.example",
			SELECTED_LLM_PROVIDER: "mistral",
		};
		expect(applyPinnedAccount(env, "mistral", client.id)).toBe(true);
		expect(env).toEqual({ MISTRAL_API_KEY: CLIENT_KEY, SELECTED_LLM_PROVIDER: "mistral" });
	});

	it("serves an alias with its provider's accounts", () => {
		const account = store.save({ provider: "google", name: "Work", apiKey: CLIENT_KEY });
		const env: Record<string, string> = {};
		expect(applyPinnedAccount(env, "gemini", account.id)).toBe(true);
		expect(env.GOOGLE_API_KEY).toBe(CLIENT_KEY);
	});

	it("runs OpenAI on the pinned key even when its page signs in with Codex", () => {
		const account = store.save({ provider: "openai", name: "Client", apiKey: CLIENT_KEY });
		const env: Record<string, string> = { OPENAI_AUTH_MODE: "codex-cli" };
		applyPinnedAccount(env, "openai", account.id);
		expect(env).toEqual({ OPENAI_AUTH_MODE: "api-key", OPENAI_API_KEY: CLIENT_KEY });
	});

	it("never hands one provider's key to another provider", () => {
		const mistral = store.save({ provider: "mistral", name: "Client", apiKey: CLIENT_KEY });
		const env: Record<string, string> = { OPENAI_API_KEY: PERSO_KEY };
		expect(applyPinnedAccount(env, "openai", mistral.id)).toBe(false);
		expect(env).toEqual({ OPENAI_API_KEY: PERSO_KEY });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("not found"));
	});

	it("falls back to the default when the pinned account is gone", () => {
		const env: Record<string, string> = { DEEPSEEK_API_KEY: PERSO_KEY };
		expect(applyPinnedAccount(env, "deepseek", "deleted-id")).toBe(false);
		expect(env).toEqual({ DEEPSEEK_API_KEY: PERSO_KEY });
	});

	it("falls back to the default when the account's key cannot be read", () => {
		const account = store.save({ provider: "grok", name: "Client", apiKey: CLIENT_KEY });
		vi.spyOn(store, "keyOf").mockReturnValue(undefined);
		const env: Record<string, string> = {};
		expect(applyPinnedAccount(env, "grok", account.id)).toBe(false);
		expect(env).toEqual({});
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("no readable key"));
	});

	it("falls back to the default when the store cannot be read", () => {
		vi.spyOn(store, "get").mockImplementation(() => {
			throw new Error("locked keychain");
		});
		expect(pinnedAccountKey("meta", "any")).toBeUndefined();
		expect(warn).toHaveBeenCalledWith("[AiAccounts] pinned account unreadable:", "locked keychain");
	});

	it("does nothing without a pin, or for a provider without accounts", () => {
		const env: Record<string, string> = { WINDSURF_API_KEY: PERSO_KEY };
		expect(applyPinnedAccount(env, "openai", undefined)).toBe(false);
		expect(applyPinnedAccount(env, "windsurf", "any")).toBe(false);
		expect(applyPinnedAccount(env, "anthropic", "any")).toBe(false);
		expect(env).toEqual({ WINDSURF_API_KEY: PERSO_KEY });
	});

	it("serves a gateway account without its base URL", () => {
		const account = store.save({ provider: "openrouter", name: "Team", apiKey: CLIENT_KEY });
		const env: Record<string, string> = {};
		expect(applyPinnedAccount(env, "openrouter", account.id)).toBe(true);
		expect(Object.values(env)).toContain(CLIENT_KEY);
	});
});

describe("servedAccountPins", () => {
	it("keeps the pins a process runs on: an account of that provider, with a key", () => {
		const client = store.save({ provider: "openai", name: "Client", apiKey: CLIENT_KEY });
		const work = store.save({ provider: "google", name: "Work", apiKey: PERSO_KEY });
		expect(
			servedAccountPins({ openai: client.id, gemini: work.id, mistral: client.id, deepseek: "gone", claude: "team" }),
		).toEqual({ openai: client.id, gemini: work.id });
		expect(servedAccountPins(undefined)).toEqual({});
	});

	it("charges no pin when the store cannot be read", () => {
		vi.spyOn(store, "get").mockImplementation(() => {
			throw new Error("locked keychain");
		});
		expect(servedAccountPins({ openai: "any" })).toEqual({});
		expect(warn).toHaveBeenCalledWith("[AiAccounts] pinned accounts unreadable:", "locked keychain");
	});
});
