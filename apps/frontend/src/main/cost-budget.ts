/**
 * The project's cost budget as the Costs page sets it, and where it stands.
 *
 * `.workpilot/cost-budget.json` is read by the backend before every agent
 * session of a task (`apps/backend/cost_budget/`): thresholds announced in the
 * task's log, the build paused at 100 %, an optional step down to a lighter
 * model, and a stall breaker. The same validation runs on both sides, so a
 * value the backend would drop is never written.
 *
 * Before this file existed, the page kept a budget inside `cost_data.json`
 * (`budgets[<project path>]`) that nothing enforced. It is still read when the
 * new file is absent, and no longer rewritten: rewriting the whole ledger from
 * here raced with the agents appending to it.
 */

import fs from "node:fs";
import path from "node:path";
import type {
	BudgetLevel,
	BudgetPeriod,
	CostBudgetConfig,
	CostBudgetStatus,
} from "../shared/types/cost-budget";
import { type LedgerUsage, readUsages } from "./workspace-ledgers";

export const BUDGET_FILE = "cost-budget.json";
const LEGACY_FILE = "cost_data.json";
const MAX_USD = 1_000_000;

export const DEFAULT_BUDGET: CostBudgetConfig = {
	limit: 0,
	period: "monthly",
	warning_threshold: 0.75,
	critical_threshold: 0.9,
	task_limit: 0,
	on_exceed: "pause",
	degrade: false,
	stall_multiplier: 3,
};

function usd(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.min(value, MAX_USD);
}

function share(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1
		? value
		: fallback;
}

/** A budget from untrusted JSON (a file, the renderer): anything odd falls to its default. */
export function parseBudget(raw: unknown): CostBudgetConfig {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_BUDGET };
	const r = raw as Record<string, unknown>;
	const warning = share(r.warning_threshold, DEFAULT_BUDGET.warning_threshold);
	const stall = r.stall_multiplier;
	return {
		limit: usd(r.limit),
		period:
			r.period === "weekly" || r.period === "total" ? r.period : "monthly",
		warning_threshold: warning,
		critical_threshold: Math.max(
			share(r.critical_threshold, DEFAULT_BUDGET.critical_threshold),
			warning,
		),
		task_limit: usd(r.task_limit),
		on_exceed: r.on_exceed === "warn" ? "warn" : "pause",
		degrade: r.degrade === true,
		stall_multiplier:
			stall === 0 ? 0 : stall === undefined ? DEFAULT_BUDGET.stall_multiplier : usd(stall),
	};
}

function readJson(file: string): unknown {
	try {
		if (fs.lstatSync(file).isSymbolicLink()) return null;
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

function workpilotDir(projectPath: string): string {
	return path.join(projectPath, ".workpilot");
}

function legacyBudget(projectPath: string): unknown {
	const data = readJson(path.join(workpilotDir(projectPath), LEGACY_FILE)) as {
		budgets?: Record<string, unknown>;
	} | null;
	const budgets = data?.budgets;
	if (!budgets || typeof budgets !== "object") return null;
	const values = Object.values(budgets);
	return budgets[projectPath] ?? (values.length === 1 ? values[0] : null);
}

export function readBudget(projectPath: string): { config: CostBudgetConfig; configured: boolean } {
	const raw = readJson(path.join(workpilotDir(projectPath), BUDGET_FILE)) ?? legacyBudget(projectPath);
	const config = parseBudget(raw);
	return { config, configured: config.limit > 0 || config.task_limit > 0 };
}

export function writeBudget(projectPath: string, input: unknown): CostBudgetConfig {
	const config = parseBudget(input);
	const dir = workpilotDir(projectPath);
	fs.mkdirSync(dir, { recursive: true });
	if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("refusing a linked .workpilot folder");
	const target = path.join(dir, BUDGET_FILE);
	const temp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(config, null, 2), "utf-8");
	fs.renameSync(temp, target);
	return config;
}

/** Where the period began, in local time; null for "total". Matches cost_budget/spend.py. */
export function periodStart(period: BudgetPeriod, now = new Date()): Date | null {
	if (period === "monthly") return new Date(now.getFullYear(), now.getMonth(), 1);
	if (period === "weekly") {
		const start = new Date(now);
		start.setDate(now.getDate() - now.getDay());
		start.setHours(0, 0, 0, 0);
		return start;
	}
	return null;
}

function levelOf(spent: number, limit: number, config: CostBudgetConfig): BudgetLevel {
	if (limit <= 0) return "ok";
	if (spent >= limit) return "exceeded";
	if (spent >= limit * config.critical_threshold) return "critical";
	if (spent >= limit * config.warning_threshold) return "warning";
	return "ok";
}

function forecast(spent: number, period: BudgetPeriod, now: Date): number {
	if (period === "monthly") {
		const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
		return (spent / now.getDate()) * days;
	}
	if (period === "weekly") return (spent / (now.getDay() + 1)) * 7;
	return spent;
}

export function budgetStatus(
	projectPath: string,
	now = new Date(),
	usages: LedgerUsage[] = readUsages(projectPath),
): CostBudgetStatus {
	const { config, configured } = readBudget(projectPath);
	const start = periodStart(config.period, now);
	const inPeriod = start ? usages.filter((u) => new Date(u.timestamp) >= start) : usages;
	const spent = inPeriod.reduce((sum, u) => sum + u.cost, 0);
	const complete = inPeriod.every((u) => u.cost > 0 || u.input_tokens + u.output_tokens === 0);
	const perTask = new Map<string, number>();
	for (const u of usages) perTask.set(u.spec_id, (perTask.get(u.spec_id) ?? 0) + u.cost);
	const tasksOverWarning =
		config.task_limit > 0
			? [...perTask.entries()]
					.filter(([id, cost]) => id && cost >= config.task_limit * config.warning_threshold)
					.map(([specId, cost]) => ({ specId, spent: cost }))
					.sort((a, b) => b.spent - a.spent)
			: [];
	return {
		config,
		configured,
		spent,
		complete,
		remaining: Math.max(0, config.limit - spent),
		utilizationPct: config.limit > 0 ? (spent / config.limit) * 100 : 0,
		level: levelOf(spent, config.limit, config),
		forecastEndOfPeriod: config.limit > 0 ? forecast(spent, config.period, now) : 0,
		tasksOverWarning,
	};
}

/** Set (or clear, with 0) one task's own limit in every copy of its spec directory. */
export function writeTaskBudget(specDirs: string[], amount: unknown): number {
	const value = usd(amount);
	let written = 0;
	for (const dir of specDirs) {
		const file = path.join(dir, "task_metadata.json");
		const current = readJson(file);
		const metadata: Record<string, unknown> =
			current && typeof current === "object" ? { ...(current as Record<string, unknown>) } : {};
		if (value > 0) metadata.budgetUsd = value;
		else delete metadata.budgetUsd;
		try {
			fs.writeFileSync(file, JSON.stringify(metadata, null, 2), "utf-8");
			written++;
		} catch {
			// a copy that vanished (worktree removed) is not an error
		}
	}
	return written;
}
