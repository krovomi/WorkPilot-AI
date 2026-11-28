/**
 * IPC of the spend and monthly budget of each AI account
 * (`ai-accounts/account-usage.ts`). The renderer is not trusted (rule S6): it
 * names an account by its key, which must be an account that exists now, and
 * an amount, checked again by the store. It only ever gets sums back.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { IPCResult } from "../../shared/types";
import {
	AI_ACCOUNT_KEY_PATTERN,
	type AiAccountUsageSnapshot,
} from "../../shared/types/ai-account-usage";
import { type AccountBudgetStore, accountBudgetStore } from "../ai-accounts/account-budgets";
import {
	accountUsageSnapshot,
	knownAccounts,
	startAccountBudgetWatch,
} from "../ai-accounts/account-usage";
import { appLog } from "../app-logger";

export function getAiAccountUsage(): IPCResult<AiAccountUsageSnapshot> {
	try {
		return { success: true, data: accountUsageSnapshot() };
	} catch (error) {
		appLog.warn("[AiAccounts] usage unreadable:", (error as Error).message);
		return { success: false, error: "Usage unreadable" };
	}
}

export function setAiAccountBudget(
	key: unknown,
	amount: unknown,
	known: ReadonlyMap<string, string> = knownAccounts(),
	store: AccountBudgetStore = accountBudgetStore(),
): IPCResult<number> {
	if (typeof key !== "string" || !AI_ACCOUNT_KEY_PATTERN.test(key) || !known.has(key)) {
		return { success: false, error: "Invalid account" };
	}
	try {
		return { success: true, data: store.setBudget(key, amount) };
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : "Refused" };
	}
}

export function registerAiAccountUsageHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.AI_ACCOUNTS_USAGE, () => getAiAccountUsage());
	ipcMain.handle(
		IPC_CHANNELS.AI_ACCOUNTS_SET_BUDGET,
		(_event, key: unknown, amount: unknown) => setAiAccountBudget(key, amount),
	);
	startAccountBudgetWatch();
}
