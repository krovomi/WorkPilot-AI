/**
 * What each AI account spent this month, added up from the cost ledgers the
 * agents keep in every project on this computer (`workspace-ledgers.ts`), and
 * the alerts of its optional monthly budget.
 *
 * A session names its account when the app started its process with one
 * (`account-attribution.ts`, written by `foundation/ai_account.py`). Older
 * sessions, and those that ran on a main key or a `profiles.json` profile,
 * name none and are left out: an account's figure never includes a guess.
 *
 * Everything stays on this computer: nothing is sent, the figures are sums of
 * files the agents already write, and a budget is a number the person typed.
 * An alert goes to the person's own channels (desktop, and ntfy or Telegram
 * when they set them), once per threshold and month, under the "review
 * needed" switch of the project where the spend was recorded.
 */

import {
	AI_ACCOUNT_BUDGET_WARNING,
	type AiAccountBudgetLevel,
	type AiAccountUsage,
	type AiAccountUsageSnapshot,
	claudeAccountKey,
} from "../../shared/types/ai-account-usage";
import { getAppLanguage } from "../app-language";
import { appLog } from "../app-logger";
import { getClaudeProfileManager } from "../claude-profile-manager";
import { notificationService } from "../notification-service";
import { projectStore } from "../project-store";
import { type LedgerUsage, readUsages } from "../workspace-ledgers";
import { type AccountBudgetStore, accountBudgetStore, type BudgetAlert } from "./account-budgets";
import { aiAccountStore } from "./ai-accounts";

/** How often a running app looks at the budgets, when at least one is set. */
export const BUDGET_CHECK_MS = 5 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;

export interface ProjectLedger {
	id: string;
	path: string;
}

/** `YYYY-MM` of `now`, in local time (the month a budget covers). */
export function monthOf(now: Date): string {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function levelOf(cost: number, budget: number): AiAccountBudgetLevel {
	if (budget <= 0) return "none";
	if (cost >= budget) return "exceeded";
	if (cost >= budget * AI_ACCOUNT_BUDGET_WARNING) return "warning";
	return "ok";
}

interface MonthTotals {
	usage: AiAccountUsage;
	/** Project id → spend, to say where most of it came from. */
	byProject: Map<string, number>;
}

/** The month of every account that spent or has a budget, project by project. */
export function monthTotals(
	projects: readonly ProjectLedger[],
	budgets: Readonly<Record<string, number>>,
	now = new Date(),
	read: (projectPath: string) => LedgerUsage[] = readUsages,
): Map<string, MonthTotals> {
	const start = new Date(now.getFullYear(), now.getMonth(), 1);
	const totals = new Map<string, MonthTotals>();
	const entry = (key: string): MonthTotals => {
		let found = totals.get(key);
		if (!found) {
			found = {
				usage: {
					key,
					costUsd: 0,
					inputTokens: 0,
					outputTokens: 0,
					sessions: 0,
					complete: true,
					budgetUsd: budgets[key] ?? 0,
					level: "none",
				},
				byProject: new Map(),
			};
			totals.set(key, found);
		}
		return found;
	};
	for (const project of projects) {
		for (const u of read(project.path)) {
			if (!u.account_id) continue;
			const at = new Date(u.timestamp);
			if (Number.isNaN(at.getTime()) || at < start) continue;
			const found = entry(u.account_id);
			found.usage.costUsd += u.cost;
			found.usage.inputTokens += u.input_tokens;
			found.usage.outputTokens += u.output_tokens;
			found.usage.sessions += 1;
			if (u.cost <= 0 && u.input_tokens + u.output_tokens > 0) found.usage.complete = false;
			found.byProject.set(project.id, (found.byProject.get(project.id) ?? 0) + u.cost);
		}
	}
	for (const key of Object.keys(budgets)) entry(key);
	for (const { usage } of totals.values()) {
		usage.costUsd = Math.round(usage.costUsd * 10_000) / 10_000;
		usage.level = levelOf(usage.costUsd, usage.budgetUsd);
	}
	return totals;
}

/** The keys of the accounts that exist now: saved accounts and Claude sign-ins. */
export function knownAccounts(): Map<string, string> {
	const names = new Map<string, string>();
	try {
		for (const account of aiAccountStore().list()) names.set(account.id, account.name);
	} catch (error) {
		appLog.warn("[AiAccounts] accounts unreadable:", (error as Error).message);
	}
	try {
		for (const profile of getClaudeProfileManager().getSettings().profiles) {
			names.set(claudeAccountKey(profile.id), profile.name);
		}
	} catch (error) {
		appLog.warn("[AiAccounts] Claude profiles unreadable:", (error as Error).message);
	}
	return names;
}

function localProjects(): ProjectLedger[] {
	return projectStore.getProjects().map((project) => ({ id: project.id, path: project.path }));
}

/** The snapshot the renderer shows: the accounts that exist, this month. */
export function accountUsageSnapshot(
	now = new Date(),
	projects: readonly ProjectLedger[] = localProjects(),
	known: ReadonlyMap<string, string> = knownAccounts(),
	budgets: AccountBudgetStore = accountBudgetStore(),
): AiAccountUsageSnapshot {
	const accounts: Record<string, AiAccountUsage> = {};
	for (const [key, { usage }] of monthTotals(projects, budgets.budgets(), now)) {
		if (known.has(key)) accounts[key] = usage;
	}
	return { month: monthOf(now), accounts };
}

const ALERT_TEXT: Record<"en" | "fr", Record<BudgetAlert, [string, string]>> = {
	en: {
		warning: [
			"AI account budget at {pct} %",
			"{name} spent {cost} of its {budget} this month.",
		],
		exceeded: [
			"AI account budget reached",
			"{name} spent {cost} this month, over its {budget} budget.",
		],
	},
	fr: {
		warning: [
			"Budget du compte IA à {pct} %",
			"{name} a dépensé {cost} sur ses {budget} ce mois-ci.",
		],
		exceeded: [
			"Budget du compte IA atteint",
			"{name} a dépensé {cost} ce mois-ci, au-delà de son budget de {budget}.",
		],
	},
};

export function alertText(
	alert: BudgetAlert,
	usage: AiAccountUsage,
	name: string,
	language: string,
): { title: string; body: string } {
	const lang = language.startsWith("fr") ? "fr" : "en";
	const [title, body] = ALERT_TEXT[lang][alert];
	const dollars = (value: number) =>
		lang === "fr" ? `${value.toFixed(2).replace(".", ",")} $` : `$${value.toFixed(2)}`;
	const fill = (text: string) =>
		text
			.replace("{pct}", String(Math.round((usage.costUsd / usage.budgetUsd) * 100)))
			.replace("{name}", name)
			.replace("{cost}", dollars(usage.costUsd))
			.replace("{budget}", dollars(usage.budgetUsd));
	return { title: fill(title), body: fill(body) };
}

export type Announce = (projectId: string, text: { title: string; body: string }) => void;

/**
 * Sends the alerts this month's spend calls for and that have not gone out
 * yet: the warning at 80 %, then the budget reached. Answers how many went.
 */
export function checkAccountBudgets(
	now = new Date(),
	projects: readonly ProjectLedger[] = localProjects(),
	budgets: AccountBudgetStore = accountBudgetStore(),
	known: ReadonlyMap<string, string> = knownAccounts(),
	announce: Announce = (projectId, text) => notificationService.announce(projectId, text),
	language = getAppLanguage(),
): number {
	const set = budgets.budgets();
	if (Object.keys(set).length === 0) return 0;
	const month = monthOf(now);
	let sent = 0;
	for (const [key, { usage, byProject }] of monthTotals(projects, set, now)) {
		const name = known.get(key);
		if (!name || usage.budgetUsd <= 0) continue;
		const alert: BudgetAlert | null =
			usage.level === "exceeded" ? "exceeded" : usage.level === "warning" ? "warning" : null;
		if (!alert || budgets.wasSent(key, month, alert)) continue;
		// Spend over a budget comes from at least one project: the one that spent most.
		let top = "";
		let most = -1;
		for (const [projectId, cost] of byProject) {
			if (cost > most) {
				top = projectId;
				most = cost;
			}
		}
		announce(top, alertText(alert, usage, name, language));
		budgets.markSent(key, month, alert);
		// Reaching the budget at once makes the warning pointless.
		if (alert === "exceeded") budgets.markSent(key, month, "warning");
		sent++;
	}
	return sent;
}

let timer: ReturnType<typeof setInterval> | null = null;

function safeCheck(): void {
	try {
		checkAccountBudgets();
	} catch (error) {
		appLog.warn("[AiAccounts] budget check failed:", (error as Error).message);
	}
}

/** Looks at the budgets a minute after start, then every five minutes. Idempotent. */
export function startAccountBudgetWatch(): void {
	if (timer) return;
	setTimeout(safeCheck, FIRST_CHECK_MS).unref?.();
	timer = setInterval(safeCheck, BUDGET_CHECK_MS);
	timer.unref?.();
}

export function stopAccountBudgetWatch(): void {
	if (timer) clearInterval(timer);
	timer = null;
}
