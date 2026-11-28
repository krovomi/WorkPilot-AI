/**
 * @vitest-environment node
 *
 * IPC of the AI accounts (ai-accounts-handlers.ts): the renderer is not
 * trusted, so ids and providers are revalidated, a key only goes back as
 * `hasKey`, and a connection test answers a short verdict, never the
 * provider's body nor the key.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ value: undefined as Record<string, unknown> | undefined }));

vi.mock("electron", () => ({ app: { getPath: () => "/unused" }, ipcMain: { handle: vi.fn() } }));
vi.mock("../../secret-storage", () => ({
	encryptSecret: (value: string) => `enc:${Buffer.from(value).toString("base64")}`,
	decryptSecret: (stored: string) => Buffer.from(stored.slice(4), "base64").toString("utf-8"),
	prepareSecrets: vi.fn(async () => undefined),
}));
vi.mock("../../app-logger", () => ({ appLog: { warn: vi.fn() } }));
vi.mock("../../settings-utils", () => ({ readSettingsFile: () => settings.value }));
vi.mock("../../services/credential-manager", () => ({
	credentialManager: { testApiKeyConnection: vi.fn() },
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { AiAccountStore, setAiAccountStoreForTests } from "../../ai-accounts/ai-accounts";
import {
	deleteAiAccount,
	listAiAccounts,
	registerAiAccountsHandlers,
	saveAiAccount,
	setDefaultAiAccount,
	signInAiAccount,
	testSavedAiAccount,
} from "../ai-accounts-handlers";

const KEY = "sk-test-0000";
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "ai-accounts-ipc-"));
	setAiAccountStoreForTests(new AiAccountStore(path.join(dir, "ai-accounts.json")));
	settings.value = undefined;
});

afterEach(() => {
	setAiAccountStoreForTests(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("AI accounts IPC", () => {
	it("registers each channel", () => {
		registerAiAccountsHandlers();
		const channels = vi.mocked(ipcMain.handle).mock.calls.map(([channel]) => channel);
		expect(channels).toEqual([
			IPC_CHANNELS.AI_ACCOUNTS_LIST,
			IPC_CHANNELS.AI_ACCOUNTS_SAVE,
			IPC_CHANNELS.AI_ACCOUNTS_DELETE,
			IPC_CHANNELS.AI_ACCOUNTS_TEST,
			IPC_CHANNELS.AI_ACCOUNTS_SET_DEFAULT,
			IPC_CHANNELS.AI_ACCOUNTS_SIGN_IN,
		]);
	});

	it("lists accounts without keys, the defaults and the providers with a main key", async () => {
		settings.value = { globalMistralApiKey: "main-key", globalOpenAIApiKey: "" };
		const saved = await saveAiAccount({ provider: "openai", name: "Perso", apiKey: KEY });
		expect(saved.success).toBe(true);
		const id = saved.data?.id as string;
		expect(setDefaultAiAccount("openai", id)).toEqual({ success: true });
		const listed = listAiAccounts();
		expect(JSON.stringify(listed)).not.toContain(KEY);
		expect(JSON.stringify(listed)).not.toContain("main-key");
		expect(listed.data).toMatchObject({
			accounts: [{ id, provider: "openai", name: "Perso", hasKey: true }],
			defaults: { openai: id },
			mainKeys: ["mistral"],
		});
	});

	it("refuses what the renderer cannot name", async () => {
		expect(await saveAiAccount(null)).toEqual({ success: false, error: "Invalid account" });
		expect(await saveAiAccount({ id: 7, provider: "openai", name: "x" })).toEqual({
			success: false,
			error: "Invalid account",
		});
		expect(await saveAiAccount({ provider: "../openai", name: "x", apiKey: KEY })).toEqual({
			success: false,
			error: "Invalid provider",
		});
		expect(deleteAiAccount("x".repeat(65))).toEqual({ success: false, error: "Invalid account" });
		expect(deleteAiAccount("missing")).toEqual({ success: false, error: "Account not found" });
		expect(setDefaultAiAccount("anthropic", null)).toEqual({ success: false, error: "Invalid provider" });
		expect(setDefaultAiAccount("openai", 3)).toEqual({ success: false, error: "Invalid account" });
		expect(setDefaultAiAccount("openai", "missing")).toEqual({
			success: false,
			error: "Account not found",
		});
		expect(setDefaultAiAccount("openai", null)).toEqual({ success: true });
	});

	it("tests an account with its own key on its provider, and answers a short verdict", async () => {
		const saved = await saveAiAccount({ provider: "mistral", name: "Work", apiKey: KEY });
		const id = saved.data?.id as string;
		const test = vi.fn(async () => ({ success: true, message: "ok", details: { modelCount: 4 } }));
		expect(await testSavedAiAccount(id, test)).toEqual({
			success: true,
			data: { ok: true, modelCount: 4 },
		});
		expect(test).toHaveBeenCalledWith("mistral", KEY);

		const refused = vi.fn(async () => ({ success: false, message: `HTTP 401 ${"x".repeat(500)}` }));
		const result = await testSavedAiAccount(id, refused);
		expect(result.data?.ok).toBe(false);
		expect(result.data?.error?.length).toBeLessThanOrEqual(200);

		const thrown = vi.fn(async () => {
			throw new Error(`boom ${KEY}`);
		});
		expect(await testSavedAiAccount(id, thrown)).toEqual({
			success: true,
			data: { ok: false, error: "Test failed" },
		});
		expect(await testSavedAiAccount("missing", test)).toEqual({
			success: false,
			error: "Account not found",
		});
		expect(await testSavedAiAccount(undefined, test)).toEqual({
			success: false,
			error: "Invalid account",
		});
	});

	it("deletes an account", async () => {
		const saved = await saveAiAccount({ provider: "grok", name: "A", apiKey: KEY });
		expect(deleteAiAccount(saved.data?.id)).toEqual({ success: true });
		expect(listAiAccounts().data?.accounts).toEqual([]);
	});

	it("hands a CLI account's sign-in terminal the command and folder chosen here", async () => {
		const saved = await saveAiAccount({ provider: "codex", name: "Perso" });
		const id = saved.data?.id as string;
		const plan = signInAiAccount(id);
		expect(plan.success).toBe(true);
		expect(plan.data?.command).toBe("codex login");
		expect(Object.keys(plan.data?.env ?? {})).toEqual(["CODEX_HOME"]);
		expect(signInAiAccount(5)).toEqual({ success: false, error: "Invalid account" });
		expect(signInAiAccount("missing")).toEqual({ success: false, error: "Account not found" });
		expect(setDefaultAiAccount("codex", id)).toEqual({ success: false, error: "This account is not signed in" });
		expect(setDefaultAiAccount("codex", null)).toEqual({ success: true });

		registerAiAccountsHandlers();
		const signIn = vi
			.mocked(ipcMain.handle)
			.mock.calls.find(([channel]) => channel === IPC_CHANNELS.AI_ACCOUNTS_SIGN_IN)?.[1];
		expect(signIn?.({} as never, id)).toMatchObject({ success: true, data: { command: "codex login" } });
	});
});
