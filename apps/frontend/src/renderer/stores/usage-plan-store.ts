import type { UsagePlan } from "@shared/types";
import { create } from "zustand";

/**
 * The plan of the account each provider's usage snapshot reports ("Claude
 * Max 20x", "ChatGPT Plus", an API key billed per use…).
 *
 * The usage indicator receives the snapshots and publishes their plan here,
 * so the authentication details show the same plan as the usage panel
 * instead of the one stored at login. No IPC listener: the indicator
 * already owns the snapshot.
 */
interface UsagePlanState {
	plans: Readonly<Record<string, UsagePlan | undefined>>;
	setPlan: (provider: string, plan: UsagePlan | undefined) => void;
}

/** "claude" and "anthropic" name the same provider. */
export function usagePlanKey(provider: string): string {
	const key = provider.trim().toLowerCase();
	return key === "claude" ? "anthropic" : key;
}

export const useUsagePlanStore = create<UsagePlanState>((set) => ({
	plans: {},
	setPlan: (provider, plan) => {
		if (!provider) return;
		const key = usagePlanKey(provider);
		set((state) =>
			state.plans[key] === plan
				? state
				: { plans: { ...state.plans, [key]: plan } },
		);
	},
}));
