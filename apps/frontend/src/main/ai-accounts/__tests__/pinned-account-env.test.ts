/**
 * @vitest-environment node
 *
 * The account a project or a card pins (pinned-account-env.ts): its key goes
 * to the provider's own endpoint, only for an account of that provider; a pin
 * that cannot be served leaves the environment as the credential manager built it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import {
	applyPinnedAccount,
	applyPinnedLoginAccount,
	pinnedAccountKey,
	servedAccountPins,
} from "../pinned-account-env";

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

describe("applyPinnedLoginAccount", () => {
	/** A Codex CLI account whose CLI signed in, as its auth.json says. */
	function codexAccount(signedIn = true) {
		const account = store.save({ provider: "codex", name: "Perso" });
		const home = store.homeOf(account.id) as string;
		if (signedIn) writeFileSync(path.join(home, "auth.json"), "{}");
		return { id: account.id, home };
	}

	it("points the CLI at the pinned account's folder, OpenAI in its Codex mode", () => {
		const { id, home } = codexAccount();
		const env: Record<string, string> = { CODEX_HOME: "/default", OPENAI_AUTH_MODE: "api-key" };
		expect(applyPinnedLoginAccount(env, "openai", id)).toBe(true);
		expect(env).toEqual({ CODEX_HOME: home, OPENAI_AUTH_MODE: "codex-cli" });
	});

	it("serves a Copilot account without touching the OpenAI mode", () => {
		const account = store.save({ provider: "copilot", name: "Work" });
		const home = store.homeOf(account.id) as string;
		writeFileSync(path.join(home, "hosts.yml"), "github.com:\n    user: someone\n");
		const env: Record<string, string> = {};
		expect(applyPinnedLoginAccount(env, "copilot", account.id)).toBe(true);
		expect(env).toEqual({ COPILOT_GH_CONFIG_DIR: home });
	});

	it("leaves the environment alone for an account not signed in, of another CLI, or none", () => {
		const { id } = codexAccount(false);
		const env: Record<string, string> = { CODEX_HOME: "/default" };
		expect(applyPinnedLoginAccount(env, "openai", id)).toBe(false);
		expect(applyPinnedLoginAccount(env, "copilot", id)).toBe(false);
		expect(applyPinnedLoginAccount(env, "openai", "gone")).toBe(false);
		expect(applyPinnedLoginAccount(env, "openai", undefined)).toBe(false);
		expect(applyPinnedLoginAccount(env, "mistral", id)).toBe(false);
		expect(env).toEqual({ CODEX_HOME: "/default" });
		expect(warn).toHaveBeenCalledTimes(3);
	});

	it("leaves the environment alone when the store cannot be read", () => {
		setAiAccountStoreForTests({
			get: () => {
				throw new Error("broken");
			},
		} as never);
		const env: Record<string, string> = {};
		expect(applyPinnedLoginAccount(env, "copilot", "x")).toBe(false);
		expect(env).toEqual({});
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
