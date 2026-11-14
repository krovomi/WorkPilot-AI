/**
 * What the agents of a project on this computer spent, passed QA and merged,
 * read from the ledgers they keep (`core/usage_tracker.py`).
 *
 * Every agent session appends to `.workpilot/cost_data.json` and counts QA
 * verdicts, merges and build times in `.workpilot/dashboard_snapshot.json`.
 * The backend now writes both at the project root, but builds that ran before
 * wrote them in their worktree (`.workpilot/worktrees/tasks/<task>/.workpilot/`)
 * — the dashboard read only the root and showed 0 for every finished task. So
 * the ledgers are read at the root and in each task workspace still on disk,
 * as the server does for its projects (`shared_features/usage_ledger.py`).
 *
 * The tasks themselves are counted from the board, never from a counter.
 */

import fs from "node:fs";
import path from "node:path";
import type { DashboardSnapshot } from "../shared/types/workspace";

export const COST_DATA_FILE = "cost_data.json";
export const SNAPSHOT_FILE = "dashboard_snapshot.json";

/** Task workspaces read, at most; and the most read of one ledger file, in bytes. */
const MAX_WORKSPACES = 500;
const MAX_FILE_BYTES: Record<string, number> = {
	[COST_DATA_FILE]: 8_000_000,
	[SNAPSHOT_FILE]: 200_000,
};

/** The board's statuses in the words of the dashboard; the others are shown as they are. */
const STATUS_WORDS: Record<string, string> = { backlog: "pending", done: "completed" };

/** One agent session's spend, as `usage_tracker` records it. */
export interface LedgerUsage {
	provider: string;
	model: string;
	input_tokens: number;
	output_tokens: number;
	cost: number;
	phase: string;
	agent_type: string;
	spec_id: string;
	timestamp: string;
}

/** A task of the board, as far as the dashboard counts it. */
export interface CountedTask {
	status: string;
	archivedAt?: string | null;
	metadata?: { archivedAt?: string | null } | null;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function label(value: unknown): string {
	return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

function listDirs(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(dir, entry.name))
			.sort();
	} catch {
		return [];
	}
}

/**
 * The `.workpilot` folders that may hold ledgers: the project's, then each
 * task workspace's (current layout, then the older `.worktrees/<task>`).
 */
export function ledgerDirs(projectPath: string): string[] {
	const root = path.join(projectPath, ".workpilot");
	const workspaces = [
		...listDirs(path.join(root, "worktrees", "tasks")),
		...listDirs(path.join(projectPath, ".worktrees")),
	].slice(0, MAX_WORKSPACES);
	return [root, ...workspaces.map((dir) => path.join(dir, ".workpilot"))];
}

function readLedger(dir: string, name: string): unknown {
	const file = path.join(dir, name);
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES[name]) return null;
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
}

function toUsage(raw: unknown): LedgerUsage | null {
	if (!raw || typeof raw !== "object") return null;
	const u = raw as Record<string, unknown>;
	const timestamp = label(u.timestamp);
	if (!timestamp) return null;
	return {
		provider: label(u.provider) || "unknown",
		model: label(u.model) || "unknown",
		input_tokens: count(u.input_tokens),
		output_tokens: count(u.output_tokens),
		cost: count(u.cost),
		phase: label(u.phase),
		agent_type: label(u.agent_type),
		spec_id: label(u.spec_id) || label(u.task_id),
		timestamp,
	};
}

/** Every agent session recorded for the project, root and task workspaces together. */
export function readUsages(projectPath: string): LedgerUsage[] {
	const usages: LedgerUsage[] = [];
	for (const dir of ledgerDirs(projectPath)) {
		const data = readLedger(dir, COST_DATA_FILE) as { usages?: unknown } | null;
		const rows = Array.isArray(data?.usages) ? data.usages : [];
		for (const raw of rows) {
			const usage = toUsage(raw);
			if (usage) usages.push(usage);
		}
	}
	return usages;
}

interface Counters {
	qaTotal: number;
	qaPassed: number;
	qaScoreSum: number;
	mergeAuto: number;
	mergeManual: number;
	durations: Record<string, number[]>;
}

/** The QA, merge and build-time counters of every snapshot, added up. */
export function readCounters(projectPath: string): Counters {
	const found: Counters = {
		qaTotal: 0,
		qaPassed: 0,
		qaScoreSum: 0,
		mergeAuto: 0,
		mergeManual: 0,
		durations: {},
	};
	for (const dir of ledgerDirs(projectPath)) {
		const snap = readLedger(dir, SNAPSHOT_FILE);
		if (!snap || typeof snap !== "object") continue;
		const s = snap as Record<string, unknown>;
		found.qaTotal += count(s._qa_total);
		found.qaPassed += count(s._qa_passed);
		found.qaScoreSum += count(s._qa_score_sum);
		found.mergeAuto += count(s.merge_auto_count);
		found.mergeManual += count(s.merge_manual_count);
		const byComplexity = s.avg_completion_by_complexity;
		if (byComplexity && typeof byComplexity === "object") {
			for (const [complexity, value] of Object.entries(byComplexity)) {
				// Each build appends its duration; an older snapshot may hold a mean.
				const seconds = (Array.isArray(value) ? value : [value]).map(count).filter((v) => v > 0);
				if (seconds.length === 0) continue;
				const key = label(complexity) || "standard";
				found.durations[key] = [...(found.durations[key] ?? []), ...seconds];
			}
		}
	}
	return found;
}

function isArchived(task: CountedTask): boolean {
	return Boolean(task.archivedAt || task.metadata?.archivedAt);
}

/** The board's tasks by status, in the dashboard's words; archived tasks left out. */
export function tasksByStatus(tasks: readonly CountedTask[]): Record<string, number> {
	const byStatus: Record<string, number> = {};
	for (const task of tasks) {
		if (isArchived(task)) continue;
		const word = STATUS_WORDS[task.status] ?? task.status;
		byStatus[word] = (byStatus[word] ?? 0) + 1;
	}
	return byStatus;
}

/**
 * The dashboard of a project on this computer: its tasks from the board, its
 * spend from the usage ledgers, its QA, merges and build times from the
 * snapshots. A session that recorded neither a token nor a cent (rows an older
 * build left behind) is not shown as a model or a provider.
 */
export function buildDashboardSnapshot(
	projectPath: string,
	tasks: readonly CountedTask[],
): DashboardSnapshot {
	const tokensByProvider: Record<string, number> = {};
	const costByModel: Record<string, number> = {};
	let totalTokens = 0;
	let totalCost = 0;
	for (const usage of readUsages(projectPath)) {
		const tokens = usage.input_tokens + usage.output_tokens;
		if (tokens === 0 && usage.cost === 0) continue;
		totalTokens += tokens;
		totalCost += usage.cost;
		tokensByProvider[usage.provider] = (tokensByProvider[usage.provider] ?? 0) + tokens;
		const model = `${usage.provider}/${usage.model}`;
		costByModel[model] = (costByModel[model] ?? 0) + usage.cost;
	}
	const counters = readCounters(projectPath);
	const avgCompletion: Record<string, number> = {};
	for (const [complexity, seconds] of Object.entries(counters.durations)) {
		avgCompletion[complexity] = seconds.reduce((a, b) => a + b, 0) / seconds.length;
	}
	return {
		tasks_by_status: tasksByStatus(tasks),
		avg_completion_by_complexity: avgCompletion,
		qa_first_pass_rate: counters.qaTotal ? (counters.qaPassed / counters.qaTotal) * 100 : 0,
		qa_avg_score: counters.qaTotal ? counters.qaScoreSum / counters.qaTotal : 0,
		total_tokens: totalTokens,
		tokens_by_provider: tokensByProvider,
		total_cost: totalCost,
		cost_by_model: costByModel,
		merge_auto_count: counters.mergeAuto,
		merge_manual_count: counters.mergeManual,
	};
}
