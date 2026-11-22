/**
 * The forge accounts saved for the whole app, as the renderer sees them
 * (`main/forge/forge-accounts.ts`): whether each has a token, never the token.
 * Read by the accounts section of the app settings and by each project's
 * GitHub, GitLab and Azure DevOps settings, which pick one.
 */
import { create } from "zustand";
import type {
	ForgeAccountInput,
	ForgeAccountTestResult,
	ForgeAccountView,
	ForgeKind,
} from "@shared/types/forge-accounts";

interface ForgeAccountsState {
	accounts: ForgeAccountView[];
	loaded: boolean;
	error: string | null;
	load: () => Promise<void>;
	/** The saved account, or a short reason it was refused. */
	save: (input: ForgeAccountInput) => Promise<{ account?: ForgeAccountView; error?: string }>;
	remove: (id: string) => Promise<string | null>;
	test: (id: string) => Promise<ForgeAccountTestResult>;
}

export const useForgeAccountsStore = create<ForgeAccountsState>((set, get) => ({
	accounts: [],
	loaded: false,
	error: null,
	load: async () => {
		try {
			const result = await window.electronAPI.listForgeAccounts();
			set(
				result.success
					? { accounts: result.data ?? [], loaded: true, error: null }
					: { loaded: true, error: result.error ?? null },
			);
		} catch (error) {
			// A page shows its own forge settings even when the list cannot be read.
			set({ loaded: true, error: error instanceof Error ? error.message : String(error) });
		}
	},
	save: async (input) => {
		const result = await window.electronAPI.saveForgeAccount(input);
		await get().load();
		return result.success ? { account: result.data } : { error: result.error };
	},
	remove: async (id) => {
		const result = await window.electronAPI.deleteForgeAccount(id);
		await get().load();
		return result.success ? null : (result.error ?? null);
	},
	test: async (id) => {
		const result = await window.electronAPI.testForgeAccount(id);
		await get().load();
		return result.success && result.data
			? result.data
			: { ok: false, error: result.error };
	},
}));

/** The saved accounts of one forge. */
export function accountsOf(accounts: readonly ForgeAccountView[], forge: ForgeKind) {
	return accounts.filter((account) => account.forge === forge);
}
