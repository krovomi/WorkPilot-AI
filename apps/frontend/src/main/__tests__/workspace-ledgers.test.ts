/**
 * The dashboard of a project on this computer: tasks from the board, spend,
 * QA, merges and build times from every ledger the project keeps.
 *
 * Regression: a project whose tasks had all finished showed 0 tasks, 0 tokens
 * and 0 € because the builds wrote their ledgers in their worktree and the
 * dashboard read only the project root (its only figure was the merge).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDashboardSnapshot, ledgerDirs, readUsages, tasksByStatus } from "../workspace-ledgers";

let project: string;

function write(relative: string, value: unknown): void {
	const file = path.join(project, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value), "utf-8");
}

const at = "2026-11-01T10:20:09+00:00";

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "wp-ledgers-"));
});

afterEach(() => {
	fs.rmSync(project, { recursive: true, force: true });
});

describe("workspace ledgers", () => {
	it("reads the root ledger and each task workspace's", () => {
		// Leub's project: three empty rows at the root, the real spend in two worktrees.
		write(".workpilot/cost_data.json", {
			usages: [
				{ provider: "claude", model: "claude-sonnet-4-6", input_tokens: 0, output_tokens: 0, cost: 0, timestamp: at },
			],
			budgets: {},
		});
		write(".workpilot/dashboard_snapshot.json", { merge_manual_count: 1 });
		write(".workpilot/worktrees/tasks/004-tutu/.workpilot/cost_data.json", {
			usages: [
				{ provider: "claude", model: "claude-haiku-4-5", input_tokens: 82, output_tokens: 2411, cost: 0.11, spec_id: "004-tutu", timestamp: at },
			],
		});
		write(".workpilot/worktrees/tasks/004-tutu/.workpilot/dashboard_snapshot.json", {
			_qa_total: 1,
			_qa_passed: 1,
			_qa_score_sum: 100,
			avg_completion_by_complexity: { simple: [120] },
		});
		write(".workpilot/worktrees/tasks/005-tutu/.workpilot/cost_data.json", {
			usages: [
				{ provider: "claude", model: "claude-haiku-4-5", input_tokens: 74, output_tokens: 2115, cost: 0.09, timestamp: at },
			],
		});
		write(".workpilot/worktrees/tasks/005-tutu/.workpilot/dashboard_snapshot.json", {
			_qa_total: 2,
			_qa_passed: 1,
			_qa_score_sum: 100,
			avg_completion_by_complexity: { simple: [240] },
		});

		const snapshot = buildDashboardSnapshot(project, [
			{ status: "done" },
			{ status: "done" },
			{ status: "human_review" },
			{ status: "backlog" },
			{ status: "done", metadata: { archivedAt: at } },
		]);

		expect(snapshot.tasks_by_status).toEqual({ completed: 2, human_review: 1, pending: 1 });
		expect(snapshot.total_tokens).toBe(82 + 2411 + 74 + 2115);
		expect(snapshot.total_cost).toBeCloseTo(0.2);
		// The empty root row names no model.
		expect(Object.keys(snapshot.cost_by_model)).toEqual(["claude/claude-haiku-4-5"]);
		expect(snapshot.tokens_by_provider).toEqual({ claude: 82 + 2411 + 74 + 2115 });
		expect(snapshot.qa_first_pass_rate).toBeCloseTo((2 / 3) * 100);
		expect(snapshot.qa_avg_score).toBeCloseTo(200 / 3);
		expect(snapshot.merge_manual_count).toBe(1);
		expect(snapshot.avg_completion_by_complexity).toEqual({ simple: 180 });
	});

	it("reads the older .worktrees layout too", () => {
		write(".worktrees/003-x/.workpilot/cost_data.json", {
			usages: [{ provider: "openai", model: "gpt-5", input_tokens: 10, output_tokens: 5, cost: 0.01, timestamp: at }],
		});
		expect(ledgerDirs(project)).toContain(path.join(project, ".worktrees", "003-x", ".workpilot"));
		expect(readUsages(project).map((u) => u.provider)).toEqual(["openai"]);
	});

	it("is empty, not broken, for a project with no ledger or a garbage one", () => {
		write(".workpilot/cost_data.json", { usages: [null, "x", { provider: "a" }, { timestamp: at, cost: -5, input_tokens: "9" }] });
		write(".workpilot/dashboard_snapshot.json", "not an object");
		const snapshot = buildDashboardSnapshot(project, []);
		expect(snapshot.total_tokens).toBe(0);
		expect(snapshot.total_cost).toBe(0);
		expect(snapshot.cost_by_model).toEqual({});
		expect(snapshot.tasks_by_status).toEqual({});
		expect(snapshot.qa_first_pass_rate).toBe(0);
	});

	it("counts every status of the board, archived tasks left out", () => {
		expect(
			tasksByStatus([
				{ status: "in_progress" },
				{ status: "pr_created" },
				{ status: "build_failed" },
				{ status: "queue", archivedAt: at },
			]),
		).toEqual({ in_progress: 1, pr_created: 1, build_failed: 1 });
	});
});
