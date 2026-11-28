/**
 * What each AI account spent this month and its monthly budget, as the main
 * process adds it up (`main/ai-accounts/account-usage.ts`). Read when
 * Settings → AI accounts or the usage popover opens, never polled.
 */
import { create } from "zustand";
import type { AiAccountUsage, AiAccountUsageSnapshot } from "@shared/types/ai-account-usage";

interface AiAccountUsageState extends AiAccountUsageSnapshot {
	loaded: boolean;
	load: () => Promise<void>;
	/** 0 removes the budget; answers a short reason when refused. */
	setBudget: (accountKey: string, amountUsd: number) => Promise<string | null>;
}

export const useAiAccountUsageStore = create<AiAccountUsageState>((set, get) => ({
	month: "",
	accounts: {},
	loaded: false,
	load: async () => {
		try {
			const result = await globalThis.electronAPI.getAiAccountUsage();
			set(result.success && result.data ? { ...result.data, loaded: true } : { loaded: true });
		} catch {
			// The accounts stay usable without their figures.
			set({ loaded: true });
		}
	},
	setBudget: async (accountKey, amountUsd) => {
		const result = await globalThis.electronAPI.setAiAccountBudget(accountKey, amountUsd);
		await get().load();
		return result.success ? null : (result.error ?? "Refused");
	},
}));

/** The month of one account; an account with nothing recorded spent nothing. */
export function usageOf(
	accounts: Readonly<Record<string, AiAccountUsage>>,
	key: string,
): AiAccountUsage {
	return (
		accounts[key] ?? {
			key,
			costUsd: 0,
			inputTokens: 0,
			outputTokens: 0,
			sessions: 0,
			complete: true,
			budgetUsd: 0,
			level: "none",
		}
	);
}
