/**
 * IPC of the forge accounts saved for the whole app (`forge/forge-accounts.ts`).
 * The renderer is not trusted (rule S6): it sends an account's fields or an
 * id, the store revalidates them, and a token only goes back as `hasToken`.
 * A connection test runs here, with the token read from the store.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { IPCResult } from "../../shared/types";
import type {
	ForgeAccountInput,
	ForgeAccountTestResult,
	ForgeAccountView,
} from "../../shared/types/forge-accounts";
import { testForgeAccount } from "../forge/forge-account-test";
import { forgeAccountStore } from "../forge/forge-accounts";
import { prepareSecrets } from "../secret-storage";
import { unmaskSecret } from "../utils/masked-secret";

const MAX_ID = 64;

function accountId(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID
		? value
		: null;
}

function failure(error: unknown): IPCResult<never> {
	return { success: false, error: error instanceof Error ? error.message : "Refused" };
}

export function listForgeAccounts(): IPCResult<ForgeAccountView[]> {
	return { success: true, data: forgeAccountStore().list() };
}

export async function saveForgeAccount(input: unknown): Promise<IPCResult<ForgeAccountView>> {
	if (!input || typeof input !== "object") return { success: false, error: "Invalid account" };
	const { id, token } = input as { id?: unknown; token?: unknown };
	if (id !== undefined && accountId(id) === null) {
		return { success: false, error: "Invalid account" };
	}
	// Encrypted ahead with the async API, so the synchronous write never asks the keyring.
	if (typeof token === "string") await prepareSecrets([unmaskSecret(token)]);
	try {
		return { success: true, data: forgeAccountStore().save(input as ForgeAccountInput) };
	} catch (error) {
		return failure(error);
	}
}

export function deleteForgeAccount(id: unknown): IPCResult {
	const checked = accountId(id);
	if (checked === null) return { success: false, error: "Invalid account" };
	return forgeAccountStore().delete(checked)
		? { success: true }
		: { success: false, error: "Account not found" };
}

export async function testSavedForgeAccount(
	id: unknown,
): Promise<IPCResult<ForgeAccountTestResult>> {
	const checked = accountId(id);
	if (checked === null) return { success: false, error: "Invalid account" };
	const store = forgeAccountStore();
	const account = store.get(checked);
	if (!account) return { success: false, error: "Account not found" };
	const result = await testForgeAccount(account, store.tokenOf(checked));
	// Bitbucket's username is the one its token signs in with: kept as typed.
	if (result.ok && result.username && account.forge !== "bitbucket") {
		store.setUsername(checked, result.username);
	}
	return { success: true, data: result };
}

export function registerForgeAccountsHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.FORGE_ACCOUNTS_LIST, () => listForgeAccounts());
	ipcMain.handle(IPC_CHANNELS.FORGE_ACCOUNTS_SAVE, (_event, input: unknown) =>
		saveForgeAccount(input),
	);
	ipcMain.handle(IPC_CHANNELS.FORGE_ACCOUNTS_DELETE, (_event, id: unknown) =>
		deleteForgeAccount(id),
	);
	ipcMain.handle(IPC_CHANNELS.FORGE_ACCOUNTS_TEST, (_event, id: unknown) =>
		testSavedForgeAccount(id),
	);
}
