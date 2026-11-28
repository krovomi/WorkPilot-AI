/**
 * IPC of the AI accounts saved for the whole app (`ai-accounts/ai-accounts.ts`).
 * The renderer is not trusted (rule S6): it sends an account's fields, an id
 * or a provider, the store revalidates them, and a key only goes back as
 * `hasKey`. A connection test runs here, with the key read from the store,
 * against the provider's own endpoint. A CLI account's sign-in terminal runs a
 * command and a folder the main process chose.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { IPCResult } from "../../shared/types";
import {
	AI_ACCOUNT_PROVIDERS,
	type AiAccountInput,
	type AiAccountSignIn,
	type AiAccountsSnapshot,
	type AiAccountTestResult,
	type AiAccountView,
} from "../../shared/types/ai-accounts";
import { hasMainKey } from "../ai-accounts/ai-account-key";
import { aiAccountStore, isAiAccountProvider } from "../ai-accounts/ai-accounts";
import { signInPlanOf } from "../ai-accounts/login-accounts";
import { isLoginProvider } from "../ai-accounts/login-specs";
import { appLog } from "../app-logger";
import { prepareSecrets } from "../secret-storage";
import { credentialManager } from "../services/credential-manager";
import { readSettingsFile } from "../settings-utils";
import { unmaskSecret } from "../utils/masked-secret";

const MAX_ID = 64;
const MAX_REASON = 200;

function accountId(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID
		? value
		: null;
}

function failure(error: unknown): IPCResult<never> {
	return { success: false, error: error instanceof Error ? error.message : "Refused" };
}

export function listAiAccounts(): IPCResult<AiAccountsSnapshot> {
	const store = aiAccountStore();
	let settings: Record<string, unknown> | undefined;
	try {
		settings = readSettingsFile() as Record<string, unknown> | undefined;
	} catch {
		settings = undefined;
	}
	return {
		success: true,
		data: {
			accounts: store.list(),
			defaults: store.defaults(),
			mainKeys: AI_ACCOUNT_PROVIDERS.filter((provider) => hasMainKey(provider, settings)),
		},
	};
}

export async function saveAiAccount(input: unknown): Promise<IPCResult<AiAccountView>> {
	if (!input || typeof input !== "object") return { success: false, error: "Invalid account" };
	const { id, apiKey } = input as { id?: unknown; apiKey?: unknown };
	if (id !== undefined && accountId(id) === null) {
		return { success: false, error: "Invalid account" };
	}
	// Encrypted ahead with the async API, so the synchronous write never asks the keyring.
	if (typeof apiKey === "string") await prepareSecrets([unmaskSecret(apiKey)]);
	try {
		return { success: true, data: aiAccountStore().save(input as AiAccountInput) };
	} catch (error) {
		return failure(error);
	}
}

export function deleteAiAccount(id: unknown): IPCResult {
	const checked = accountId(id);
	if (checked === null) return { success: false, error: "Invalid account" };
	return aiAccountStore().delete(checked)
		? { success: true }
		: { success: false, error: "Account not found" };
}

export function setDefaultAiAccount(provider: unknown, id: unknown): IPCResult {
	if (!isAiAccountProvider(provider) && !isLoginProvider(provider)) {
		return { success: false, error: "Invalid provider" };
	}
	const checked = id === null ? null : accountId(id);
	if (id !== null && checked === null) return { success: false, error: "Invalid account" };
	try {
		aiAccountStore().setDefault(provider, checked);
		return { success: true };
	} catch (error) {
		return failure(error);
	}
}

/** The connection test's outcome, without anything the provider answered beyond a count. */
export async function testSavedAiAccount(
	id: unknown,
	test: (provider: string, apiKey: string) => Promise<{
		success: boolean;
		message: string;
		details?: { modelCount?: unknown };
	}> = (provider, apiKey) => credentialManager.testApiKeyConnection(provider, apiKey),
): Promise<IPCResult<AiAccountTestResult>> {
	const checked = accountId(id);
	if (checked === null) return { success: false, error: "Invalid account" };
	const store = aiAccountStore();
	const account = store.get(checked);
	if (!account) return { success: false, error: "Account not found" };
	const apiKey = store.keyOf(checked);
	if (!apiKey) return { success: true, data: { ok: false, error: "No key" } };
	try {
		// The provider's own endpoint: no URL comes from the renderer.
		const result = await test(account.provider, apiKey);
		const count = result.details?.modelCount;
		return {
			success: true,
			data: result.success
				? { ok: true, ...(typeof count === "number" ? { modelCount: count } : {}) }
				: { ok: false, error: result.message.slice(0, MAX_REASON) },
		};
	} catch (error) {
		appLog.warn("[AiAccounts] connection test failed:", (error as Error).message);
		return { success: true, data: { ok: false, error: "Test failed" } };
	}
}

/** The sign-in terminal of a CLI account: its command and folder, chosen here. */
export function signInAiAccount(id: unknown): IPCResult<AiAccountSignIn> {
	const checked = accountId(id);
	if (checked === null) return { success: false, error: "Invalid account" };
	const plan = signInPlanOf(checked);
	return plan ? { success: true, data: plan } : { success: false, error: "Account not found" };
}

export function registerAiAccountsHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.AI_ACCOUNTS_LIST, () => listAiAccounts());
	ipcMain.handle(IPC_CHANNELS.AI_ACCOUNTS_SAVE, (_event, input: unknown) => saveAiAccount(input));
	ipcMain.handle(IPC_CHANNELS.AI_ACCOUNTS_DELETE, (_event, id: unknown) => deleteAiAccount(id));
	ipcMain.handle(IPC_CHANNELS.AI_ACCOUNTS_TEST, (_event, id: unknown) => testSavedAiAccount(id));
	ipcMain.handle(
		IPC_CHANNELS.AI_ACCOUNTS_SET_DEFAULT,
		(_event, provider: unknown, id: unknown) => setDefaultAiAccount(provider, id),
	);
	ipcMain.handle(IPC_CHANNELS.AI_ACCOUNTS_SIGN_IN, (_event, id: unknown) => signInAiAccount(id));
}
