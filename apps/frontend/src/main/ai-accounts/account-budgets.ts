/**
 * The monthly budget of each AI account, and which of its alerts already went
 * out this month, so each goes out once.
 *
 * `<userData>/config/ai-account-budgets.json`, written whole (temporary file
 * then rename), mode 0600. Keys are account keys (`ai-account-usage.ts`); no
 * secret lives here. Kept apart from `ai-accounts.json` so that a budget never
 * rewrites the file that holds the keys.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import {
	AI_ACCOUNT_BUDGET_MAX_USD,
	AI_ACCOUNT_KEY_PATTERN,
} from "../../shared/types/ai-account-usage";

/** An alert sent for a month: at the warning share, then at the budget. */
export type BudgetAlert = "warning" | "exceeded";

const MAX_ENTRIES = 500;
const MONTH = /^\d{4}-\d{2}$/;

interface BudgetFile {
	budgets: Record<string, number>;
	/** Account key → the month and the alerts sent in it. */
	alerts: Record<string, { month: string; sent: BudgetAlert[] }>;
}

/** A budget from untrusted input: a finite amount in (0, max], else null. */
export function budgetAmount(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
	if (value > AI_ACCOUNT_BUDGET_MAX_USD) return null;
	return Math.round(value * 100) / 100;
}

function isAlert(value: unknown): value is BudgetAlert {
	return value === "warning" || value === "exceeded";
}

export class AccountBudgetStore {
	constructor(private readonly filePath: string) {}

	private read(): BudgetFile {
		const file: BudgetFile = { budgets: {}, alerts: {} };
		let parsed: { budgets?: unknown; alerts?: unknown };
		try {
			parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
		} catch {
			return file;
		}
		if (parsed?.budgets && typeof parsed.budgets === "object") {
			for (const [key, value] of Object.entries(parsed.budgets).slice(0, MAX_ENTRIES)) {
				const amount = budgetAmount(value);
				if (AI_ACCOUNT_KEY_PATTERN.test(key) && amount) file.budgets[key] = amount;
			}
		}
		if (parsed?.alerts && typeof parsed.alerts === "object") {
			for (const [key, value] of Object.entries(parsed.alerts).slice(0, MAX_ENTRIES)) {
				const entry = value as { month?: unknown; sent?: unknown } | null;
				if (!AI_ACCOUNT_KEY_PATTERN.test(key) || typeof entry?.month !== "string") continue;
				if (!MONTH.test(entry.month) || !Array.isArray(entry.sent)) continue;
				file.alerts[key] = { month: entry.month, sent: entry.sent.filter(isAlert) };
			}
		}
		return file;
	}

	private write(file: BudgetFile): void {
		mkdirSync(path.dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ version: 1, ...file }, null, 2)}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
		renameSync(temporary, this.filePath);
	}

	budgets(): Record<string, number> {
		return this.read().budgets;
	}

	/** Sets the monthly budget of `key`; 0 removes it. Throws a short reason when refused. */
	setBudget(key: string, amount: unknown): number {
		if (!AI_ACCOUNT_KEY_PATTERN.test(key)) throw new Error("Invalid account");
		const value = budgetAmount(amount);
		if (value === null) throw new Error("Invalid amount");
		const file = this.read();
		if (value === 0) {
			delete file.budgets[key];
		} else {
			if (!(key in file.budgets) && Object.keys(file.budgets).length >= MAX_ENTRIES) {
				throw new Error("Too many budgets");
			}
			file.budgets[key] = value;
		}
		// A new amount starts the month's alerts over.
		delete file.alerts[key];
		this.write(file);
		return value;
	}

	/** Whether `alert` already went out for `key` in `month`. */
	wasSent(key: string, month: string, alert: BudgetAlert): boolean {
		const entry = this.read().alerts[key];
		return entry?.month === month && entry.sent.includes(alert);
	}

	markSent(key: string, month: string, alert: BudgetAlert): void {
		const file = this.read();
		const entry = file.alerts[key];
		const sent = entry?.month === month ? entry.sent : [];
		if (!sent.includes(alert)) sent.push(alert);
		file.alerts[key] = { month, sent };
		this.write(file);
	}

	/** Forgets the budget and alerts of an account that no longer exists. */
	forget(key: string): void {
		const file = this.read();
		if (!(key in file.budgets) && !(key in file.alerts)) return;
		delete file.budgets[key];
		delete file.alerts[key];
		this.write(file);
	}
}

let defaultStore: AccountBudgetStore | null = null;

export function accountBudgetStore(): AccountBudgetStore {
	defaultStore ??= new AccountBudgetStore(
		path.join(app.getPath("userData"), "config", "ai-account-budgets.json"),
	);
	return defaultStore;
}

/** Points the app's store at another file (tests). */
export function setAccountBudgetStoreForTests(store: AccountBudgetStore | null): void {
	defaultStore = store;
}
