/**
 * Forge accounts saved for the whole app (`main/forge/forge-accounts.ts`):
 * the renderer sees whether an account has a token, never the token.
 */

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	ForgeAccountInput,
	ForgeAccountTestResult,
	ForgeAccountView,
} from "../../../shared/types/forge-accounts";
import type { IPCResult } from "../../../shared/types";
import { invokeIpc } from "./ipc-utils";

export interface ForgeAccountsAPI {
	listForgeAccounts: () => Promise<IPCResult<ForgeAccountView[]>>;
	saveForgeAccount: (input: ForgeAccountInput) => Promise<IPCResult<ForgeAccountView>>;
	deleteForgeAccount: (id: string) => Promise<IPCResult>;
	testForgeAccount: (id: string) => Promise<IPCResult<ForgeAccountTestResult>>;
}

export const createForgeAccountsAPI = (): ForgeAccountsAPI => ({
	listForgeAccounts: () => invokeIpc(IPC_CHANNELS.FORGE_ACCOUNTS_LIST),
	saveForgeAccount: (input) => invokeIpc(IPC_CHANNELS.FORGE_ACCOUNTS_SAVE, input),
	deleteForgeAccount: (id) => invokeIpc(IPC_CHANNELS.FORGE_ACCOUNTS_DELETE, id),
	testForgeAccount: (id) => invokeIpc(IPC_CHANNELS.FORGE_ACCOUNTS_TEST, id),
});
