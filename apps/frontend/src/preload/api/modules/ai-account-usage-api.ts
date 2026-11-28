/**
 * What each AI account spent this month and its optional monthly budget
 * (`main/ai-accounts/account-usage.ts`): sums, never a key.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { IPCResult } from "../../../shared/types";
import type { AiAccountUsageSnapshot } from "../../../shared/types/ai-account-usage";
import { invokeIpc } from "./ipc-utils";

export interface AiAccountUsageAPI {
	getAiAccountUsage: () => Promise<IPCResult<AiAccountUsageSnapshot>>;
	/** `amountUsd` 0 removes the budget. */
	setAiAccountBudget: (accountKey: string, amountUsd: number) => Promise<IPCResult<number>>;
}

export const createAiAccountUsageAPI = (): AiAccountUsageAPI => ({
	getAiAccountUsage: () => invokeIpc(IPC_CHANNELS.AI_ACCOUNTS_USAGE),
	setAiAccountBudget: (accountKey, amountUsd) =>
		invokeIpc(IPC_CHANNELS.AI_ACCOUNTS_SET_BUDGET, accountKey, amountUsd),
});
