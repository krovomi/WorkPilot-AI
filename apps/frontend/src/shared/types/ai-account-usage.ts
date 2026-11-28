/**
 * What each AI account spent this month, and its optional monthly budget
 * (`main/ai-accounts/account-usage.ts`). An account is named by its key: the
 * id of an account of Settings → AI accounts, or `claude:<profile id>` for a
 * Claude sign-in. Nothing here is a key or a prompt: sums of the cost ledgers
 * the agents keep on this computer.
 */

/** Share of the budget at which the first alert goes out. */
export const AI_ACCOUNT_BUDGET_WARNING = 0.8;

/** The highest monthly budget accepted, in US dollars. */
export const AI_ACCOUNT_BUDGET_MAX_USD = 1_000_000;

/** An account key: an account id, or `claude:` and a profile id. */
export const AI_ACCOUNT_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

/** The key of a Claude sign-in (an OAuth profile). */
export function claudeAccountKey(profileId: string): string {
	return `claude:${profileId}`;
}

/** Where an account stands against its budget; `none` when it has no budget. */
export type AiAccountBudgetLevel = "none" | "ok" | "warning" | "exceeded";

export interface AiAccountUsage {
	key: string;
	/** Spend of the month, in US dollars, as the ledgers priced it. */
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	/** Agent sessions recorded this month. */
	sessions: number;
	/** False when a session used tokens with no price known: the cost is a floor. */
	complete: boolean;
	/** The monthly budget in US dollars; 0 means none. */
	budgetUsd: number;
	level: AiAccountBudgetLevel;
}

export interface AiAccountUsageSnapshot {
	/** The month added up, `YYYY-MM` in local time. */
	month: string;
	/** Account key → its month. An account with no spend and no budget is absent. */
	accounts: Record<string, AiAccountUsage>;
}
