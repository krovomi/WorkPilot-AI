/**
 * The AI accounts saved for the whole app, as the renderer sees them
 * (`main/ai-accounts/ai-accounts.ts`): whether each has a key, never the key.
 * Read by Settings → AI accounts and by the header's usage popover, which
 * switches a provider's default account in one click.
 */
import { create } from "zustand";
import type {
	AiAccountInput,
	AiAccountsSnapshot,
	AiAccountTestResult,
	AiAccountView,
} from "@shared/types/ai-accounts";

interface AiAccountsState extends AiAccountsSnapshot {
	loaded: boolean;
	error: string | null;
	load: () => Promise<void>;
	/** The saved account, or a short reason it was refused. */
	save: (input: AiAccountInput) => Promise<{ account?: AiAccountView; error?: string }>;
	remove: (id: string) => Promise<string | null>;
	test: (id: string) => Promise<AiAccountTestResult>;
	/** `id` null goes back to the provider's main key; answers a reason when refused. */
	setDefault: (provider: string, id: string | null) => Promise<string | null>;
}

export const useAiAccountsStore = create<AiAccountsState>((set, get) => ({
	accounts: [],
	defaults: {},
	mainKeys: [],
	loaded: false,
	error: null,
	load: async () => {
		try {
			const result = await globalThis.electronAPI.listAiAccounts();
			set(
				result.success && result.data
					? { ...result.data, loaded: true, error: null }
					: { loaded: true, error: result.error ?? null },
			);
		} catch (error) {
			// The pages keep working on each provider's main key when the list cannot be read.
			set({ loaded: true, error: error instanceof Error ? error.message : String(error) });
		}
	},
	save: async (input) => {
		const result = await globalThis.electronAPI.saveAiAccount(input);
		await get().load();
		return result.success ? { account: result.data } : { error: result.error };
	},
	remove: async (id) => {
		const result = await globalThis.electronAPI.deleteAiAccount(id);
		await get().load();
		return result.success ? null : (result.error ?? null);
	},
	test: async (id) => {
		const result = await globalThis.electronAPI.testAiAccount(id);
		return result.success && result.data ? result.data : { ok: false, error: result.error };
	},
	setDefault: async (provider, id) => {
		const result = await globalThis.electronAPI.setDefaultAiAccount(provider, id);
		await get().load();
		return result.success ? null : (result.error ?? null);
	},
}));

/** The saved accounts of one provider. */
export function aiAccountsOf(
	accounts: readonly AiAccountView[],
	provider: string,
): AiAccountView[] {
	return accounts.filter((account) => account.provider === provider);
}

/** The default account of `provider`, when one was chosen. */
export function defaultAiAccountOf(
	snapshot: Pick<AiAccountsSnapshot, "accounts" | "defaults">,
	provider: string,
): AiAccountView | undefined {
	const id = snapshot.defaults[provider];
	return id ? snapshot.accounts.find((account) => account.id === id) : undefined;
}
