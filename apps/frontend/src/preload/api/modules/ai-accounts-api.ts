/**
 * AI accounts saved for the whole app (`main/ai-accounts/ai-accounts.ts`):
 * the renderer sees whether an account has a key, never the key.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { IPCResult } from "../../../shared/types";
import type {
	AiAccountInput,
	AiAccountsSnapshot,
	AiAccountTestResult,
	AiAccountView,
} from "../../../shared/types/ai-accounts";
import { invokeIpc } from "./ipc-utils";

export interface AiAccountsAPI {
	listAiAccounts: () => Promise<IPCResult<AiAccountsSnapshot>>;
	saveAiAccount: (input: AiAccountInput) => Promise<IPCResult<AiAccountView>>;
	deleteAiAccount: (id: string) => Promise<IPCResult>;
	testAiAccount: (id: string) => Promise<IPCResult<AiAccountTestResult>>;
	/** `id` null goes back to the key typed on the provider's own page. */
	setDefaultAiAccount: (provider: string, id: string | null) => Promise<IPCResult>;
}

export const createAiAccountsAPI = (): AiAccountsAPI => ({
	listAiAccounts: () => invokeIpc(IPC_CHANNELS.AI_ACCOUNTS_LIST),
	saveAiAccount: (input) => invokeIpc(IPC_CHANNELS.AI_ACCOUNTS_SAVE, input),
	deleteAiAccount: (id) => invokeIpc(IPC_CHANNELS.AI_ACCOUNTS_DELETE, id),
	testAiAccount: (id) => invokeIpc(IPC_CHANNELS.AI_ACCOUNTS_TEST, id),
	setDefaultAiAccount: (provider, id) =>
		invokeIpc(IPC_CHANNELS.AI_ACCOUNTS_SET_DEFAULT, provider, id),
});
