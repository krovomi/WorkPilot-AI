/**
 * @vitest-environment node
 *
 * The coding-agent CLIs' accounts (login-specs.ts, login-accounts.ts and the
 * store's CLI accounts): a folder per account under the store's own root, no
 * key, a default only once its CLI has signed in, the folder erased with the
 * account, and the variables the backend and the sign-in terminal receive.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_LOGIN_PROVIDERS, loginProviderOf } from "../../../shared/types/ai-accounts";
import { isWindows } from "../../platform";

vi.mock("electron", () => ({ app: { getPath: () => "/unused" } }));
vi.mock("../../secret-storage", () => ({
	encryptSecret: (value: string) => `enc:${value}`,
	decryptSecret: (stored: string) => stored.replace(/^enc:/, ""),
}));
const warn = vi.hoisted(() => vi.fn());
vi.mock("../../app-logger", () => ({ appLog: { warn } }));

import { AiAccountStore, setAiAccountStoreForTests } from "../ai-accounts";
import {
	applyPinnedLogin,
	defaultLoginHome,
	isSignInEnv,
	loginAccountEnv,
	pinnedLoginHome,
	signInPlanOf,
} from "../login-accounts";
import { isLoginProvider, LOGIN_SPECS } from "../login-specs";

let dir: string;
let file: string;
let store: AiAccountStore;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "login-accounts-"));
	file = path.join(dir, "config", "ai-accounts.json");
	store = new AiAccountStore(file);
	setAiAccountStoreForTests(store);
	warn.mockReset();
});

afterEach(() => {
	setAiAccountStoreForTests(null);
	rmSync(dir, { recursive: true, force: true });
});

/** Writes the file a CLI leaves once signed in. */
function signIn(provider: string, home: string): void {
	if (provider === "copilot") writeFileSync(path.join(home, "hosts.yml"), "github.com:\n    user: someone\n");
	if (provider === "codex") writeFileSync(path.join(home, "auth.json"), "{}");
	if (provider === "gemini-cli") {
		mkdirSync(path.join(home, ".gemini"));
		writeFileSync(path.join(home, ".gemini", "oauth_creds.json"), "{}");
	}
}

describe("login providers", () => {
	it("has one spec per provider the renderer lists, and maps the cards to them", () => {
		expect(Object.keys(LOGIN_SPECS).sort()).toEqual([...AI_LOGIN_PROVIDERS].sort());
		expect(isLoginProvider("codex")).toBe(true);
		expect(isLoginProvider("openai")).toBe(false);
		expect(isLoginProvider("toString")).toBe(false);
		expect(isLoginProvider(1)).toBe(false);
		expect(loginProviderOf(" OpenAI ")).toBe("codex");
		expect(loginProviderOf("copilot")).toBe("copilot");
		expect(loginProviderOf("mistral")).toBeUndefined();
		expect(loginProviderOf(null)).toBeUndefined();
	});

	it("says signed in only once the CLI's own file is there", () => {
		for (const provider of AI_LOGIN_PROVIDERS) {
			const home = mkdtempSync(path.join(dir, `${provider}-`));
			expect(LOGIN_SPECS[provider].signedIn(home)).toBe(false);
			signIn(provider, home);
			expect(LOGIN_SPECS[provider].signedIn(home)).toBe(true);
		}
	});

	it("does not take another host in hosts.yml for a GitHub sign-in", () => {
		const home = mkdtempSync(path.join(dir, "gh-"));
		writeFileSync(path.join(home, "hosts.yml"), "ghe.example.com:\n    user: someone\n");
		expect(LOGIN_SPECS.copilot.signedIn(home)).toBe(false);
	});
});

describe("CLI accounts in the store", () => {
	it("creates a private folder under the store's root and keeps no key", () => {
		const account = store.save({ provider: "codex", name: " Perso ", apiKey: "sk-test-0000" });
		expect(account).toMatchObject({ provider: "codex", name: "Perso", kind: "login", signedIn: false, hasKey: false });
		const home = store.homeOf(account.id) as string;
		expect(home).toBe(path.join(dir, "config", "ai-account-homes", "codex", account.id));
		expect(existsSync(home)).toBe(true);
		if (!isWindows()) expect(statSync(home).mode & 0o777).toBe(0o700);
		const raw = readFileSync(file, "utf-8");
		expect(raw).not.toContain("sk-test-0000");
		expect(JSON.stringify(store.list())).not.toContain(home);
	});

	it("only renames an account, and never moves it to another provider", () => {
		const account = store.save({ provider: "copilot", name: "Work" });
		const home = store.homeOf(account.id);
		expect(store.save({ id: account.id, provider: "copilot", name: "Client" }).name).toBe("Client");
		expect(store.homeOf(account.id)).toBe(home);
		expect(() => store.save({ id: account.id, provider: "gemini-cli", name: "X" })).toThrow("Invalid provider");
		expect(() => store.save({ id: "nope", provider: "copilot", name: "X" })).toThrow("Account not found");
	});

	it("caps the number of accounts", () => {
		const accounts = Array.from({ length: 100 }, (_, i) => ({
			id: `a${i}`,
			provider: "openai",
			name: `A${i}`,
			apiKey: "enc:k",
			createdAt: "2026-11-28T00:00:00.000Z",
		}));
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ accounts, defaults: {} }));
		expect(() => store.save({ provider: "codex", name: "One more" })).toThrow("Too many accounts");
	});

	it("drops a folder on disk that is not under the store's root", () => {
		mkdirSync(path.dirname(file), { recursive: true });
		const outside = mkdtempSync(path.join(dir, "outside-"));
		signIn("codex", outside);
		writeFileSync(
			file,
			JSON.stringify({
				accounts: [{ id: "x", provider: "codex", name: "X", home: outside, createdAt: "2026-11-28T00:00:00.000Z" }],
				defaults: { codex: "x" },
			}),
		);
		expect(store.homeOf("x")).toBeUndefined();
		expect(store.get("x")?.signedIn).toBe(false);
		expect(store.defaultHomeOf("codex")).toBeUndefined();
		expect(store.isLoginHome("codex", outside)).toBe(false);
		store.delete("x");
		expect(existsSync(outside)).toBe(true);
	});

	it("becomes the default only once signed in, and erases its folder when deleted", () => {
		const account = store.save({ provider: "gemini-cli", name: "Perso" });
		const home = store.homeOf(account.id) as string;
		expect(() => store.setDefault("gemini-cli", account.id)).toThrow("This account is not signed in");
		expect(store.defaultHomeOf("gemini-cli")).toBeUndefined();

		signIn("gemini-cli", home);
		store.setDefault("gemini-cli", account.id);
		expect(store.defaults()).toEqual({ "gemini-cli": account.id });
		expect(store.defaultHomeOf("gemini-cli")).toBe(home);
		expect(store.isLoginHome("gemini-cli", home)).toBe(true);
		expect(store.isLoginHome("codex", home)).toBe(false);

		expect(store.delete(account.id)).toBe(true);
		expect(existsSync(home)).toBe(false);
		expect(store.defaults()).toEqual({});
	});

	it("refuses as the default a key account whose key is gone", () => {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({
				accounts: [{ id: "k", provider: "openai", name: "K", createdAt: "2026-11-28T00:00:00.000Z" }],
				defaults: {},
			}),
		);
		expect(() => store.setDefault("openai", "k")).toThrow("This account has no key");
	});
});

describe("login-accounts", () => {
	it("hands the backend the folder variable of each CLI that has a default", () => {
		expect(loginAccountEnv()).toEqual({});
		const copilot = store.save({ provider: "copilot", name: "Work" });
		const codex = store.save({ provider: "codex", name: "Perso" });
		signIn("copilot", store.homeOf(copilot.id) as string);
		signIn("codex", store.homeOf(codex.id) as string);
		store.setDefault("copilot", copilot.id);
		store.setDefault("codex", codex.id);
		expect(loginAccountEnv()).toEqual({
			COPILOT_GH_CONFIG_DIR: store.homeOf(copilot.id),
			CODEX_HOME: store.homeOf(codex.id),
		});
		expect(defaultLoginHome("codex")).toBe(store.homeOf(codex.id));
		expect(defaultLoginHome("gemini-cli")).toBeUndefined();
	});

	it("goes back to the system's sign-in when the store cannot be read", () => {
		setAiAccountStoreForTests({
			defaultHomeOf: () => {
				throw new Error("broken");
			},
			isLoginHome: () => {
				throw new Error("broken");
			},
		} as unknown as AiAccountStore);
		expect(defaultLoginHome("codex")).toBeUndefined();
		expect(warn).toHaveBeenCalled();
		expect(isSignInEnv("CODEX_HOME", "/somewhere")).toBe(false);
	});

	it("plans a sign-in terminal with the CLI's command and the account's folder only", () => {
		const account = store.save({ provider: "copilot", name: "Work" });
		const plan = signInPlanOf(account.id);
		expect(plan).toMatchObject({
			command: LOGIN_SPECS.copilot.command,
			env: { GH_CONFIG_DIR: store.homeOf(account.id) },
		});
		expect(plan?.terminalId).toMatch(/^ai-account-login-copilot-\d+$/);
		const keyAccount = store.save({ provider: "openai", name: "Key", apiKey: "sk-test-0000" });
		expect(signInPlanOf(keyAccount.id)).toBeUndefined();
		expect(signInPlanOf("missing")).toBeUndefined();
	});

	it("lets a terminal take only a CLI's variable naming one of that CLI's folders", () => {
		const account = store.save({ provider: "codex", name: "Perso" });
		const home = store.homeOf(account.id) as string;
		expect(isSignInEnv("CODEX_HOME", home)).toBe(true);
		expect(isSignInEnv("GH_CONFIG_DIR", home)).toBe(false);
		expect(isSignInEnv("CODEX_HOME", path.join(home, ".."))).toBe(false);
		expect(isSignInEnv("LD_PRELOAD", home)).toBe(false);
		expect(isSignInEnv("CODEX_HOME", 42)).toBe(false);
	});
});

describe("pinned CLI accounts", () => {
	it("points the task's CLI at the pinned signed-in account, over the default", () => {
		const work = store.save({ provider: "copilot", name: "Work" });
		const client = store.save({ provider: "copilot", name: "Client" });
		signIn("copilot", store.homeOf(work.id) as string);
		signIn("copilot", store.homeOf(client.id) as string);
		store.setDefault("copilot", work.id);
		const env = { ...loginAccountEnv() };
		expect(applyPinnedLogin(env, "copilot", client.id)).toBe(true);
		expect(env).toEqual({ COPILOT_GH_CONFIG_DIR: store.homeOf(client.id) });
	});

	it("runs OpenAI on the pinned Codex sign-in, and Gemini CLI in its folder", () => {
		const codex = store.save({ provider: "codex", name: "Plan" });
		const gemini = store.save({ provider: "gemini-cli", name: "Google" });
		signIn("codex", store.homeOf(codex.id) as string);
		signIn("gemini-cli", store.homeOf(gemini.id) as string);
		const env: Record<string, string> = { OPENAI_AUTH_MODE: "api-key" };
		expect(applyPinnedLogin(env, "openai", codex.id)).toBe(true);
		expect(applyPinnedLogin(env, "gemini-cli", gemini.id)).toBe(true);
		expect(env).toEqual({
			OPENAI_AUTH_MODE: "codex-cli",
			CODEX_HOME: store.homeOf(codex.id),
			GEMINI_CLI_HOME: store.homeOf(gemini.id),
		});
	});

	it("keeps the default when the pin is absent, gone, of another CLI or signed out", () => {
		const codex = store.save({ provider: "codex", name: "Plan" });
		const signedOut = store.save({ provider: "copilot", name: "Later" });
		signIn("codex", store.homeOf(codex.id) as string);
		const env: Record<string, string> = {};
		expect(applyPinnedLogin(env, "copilot", undefined)).toBe(false);
		expect(applyPinnedLogin(env, "copilot", "missing")).toBe(false);
		expect(applyPinnedLogin(env, "copilot", codex.id)).toBe(false);
		expect(applyPinnedLogin(env, "copilot", signedOut.id)).toBe(false);
		expect(applyPinnedLogin(env, "mistral", codex.id)).toBe(false);
		expect(env).toEqual({});
		expect(warn).toHaveBeenCalledTimes(3);
	});

	it("keeps the default when the store cannot be read", () => {
		setAiAccountStoreForTests({
			get: () => {
				throw new Error("broken");
			},
		} as unknown as AiAccountStore);
		expect(pinnedLoginHome("codex", "some-id")).toBeUndefined();
		expect(warn).toHaveBeenCalledWith("[ai-accounts] pinned CLI account unreadable:", "broken");
	});
});
