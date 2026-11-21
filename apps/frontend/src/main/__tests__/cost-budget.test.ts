/**
 * The project's cost budget (#355): the file the backend enforces, written
 * only with values it would accept, and where the budget stands.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BUDGET_FILE,
	budgetStatus,
	DEFAULT_BUDGET,
	parseBudget,
	periodStart,
	readBudget,
	writeBudget,
	writeTaskBudget,
} from "../cost-budget";
import { backendPauseMessage } from "../backend-pause-notify";
import type { LedgerUsage } from "../workspace-ledgers";

let project: string;

function usage(cost: number, spec: string, timestamp: string, tokens = 10): LedgerUsage {
	return {
		provider: "openai",
		model: "gpt-5.5",
		input_tokens: tokens,
		output_tokens: 0,
		cost,
		phase: "coding",
		agent_type: "coder",
		spec_id: spec,
		timestamp,
	};
}

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "wp-budget-"));
});

afterEach(() => {
	fs.rmSync(project, { recursive: true, force: true });
});

describe("parseBudget", () => {
	it("drops what the backend would drop", () => {
		const cfg = parseBudget({
			limit: -5,
			period: "yearly",
			task_limit: "12",
			on_exceed: "rm -rf",
			warning_threshold: 3,
			critical_threshold: 0.1,
			degrade: "true",
			stall_multiplier: Number.NaN,
		});
		expect(cfg).toEqual({ ...DEFAULT_BUDGET, critical_threshold: 0.75, stall_multiplier: 0 });
	});

	it("caps an absurd amount and keeps a sane one", () => {
		expect(parseBudget({ limit: 1e12, task_limit: 4.5, on_exceed: "warn" })).toMatchObject({
			limit: 1_000_000,
			task_limit: 4.5,
			on_exceed: "warn",
		});
	});

	it("is the default for anything that is not an object", () => {
		expect(parseBudget("50")).toEqual(DEFAULT_BUDGET);
		expect(parseBudget(null)).toEqual(DEFAULT_BUDGET);
	});
});

describe("readBudget / writeBudget", () => {
	it("writes the validated budget to its own file, never into the ledger", () => {
		fs.mkdirSync(path.join(project, ".workpilot"));
		const ledger = path.join(project, ".workpilot", "cost_data.json");
		fs.writeFileSync(ledger, JSON.stringify({ usages: [], budgets: {} }), "utf-8");
		writeBudget(project, { limit: 20, period: "weekly", task_limit: 2 });
		const saved = JSON.parse(fs.readFileSync(path.join(project, ".workpilot", BUDGET_FILE), "utf-8"));
		expect(saved).toMatchObject({ limit: 20, period: "weekly", task_limit: 2 });
		expect(JSON.parse(fs.readFileSync(ledger, "utf-8"))).toEqual({ usages: [], budgets: {} });
		expect(readBudget(project).configured).toBe(true);
	});

	it("still reads a budget set before, inside cost_data.json", () => {
		fs.mkdirSync(path.join(project, ".workpilot"));
		fs.writeFileSync(
			path.join(project, ".workpilot", "cost_data.json"),
			JSON.stringify({ usages: [], budgets: { [project]: { limit: 30, period: "monthly" } } }),
			"utf-8",
		);
		expect(readBudget(project).config.limit).toBe(30);
	});

	it("is unset by default", () => {
		expect(readBudget(project)).toEqual({ config: DEFAULT_BUDGET, configured: false });
	});
});

describe("budgetStatus", () => {
	it("counts the period, flags a floor and lists the tasks near their limit", () => {
		const now = new Date(2026, 10, 14, 12);
		writeBudget(project, { limit: 10, period: "monthly", task_limit: 4 });
		const usages = [
			usage(6, "001-a", new Date(2026, 10, 2).toISOString()),
			usage(3.5, "002-b", new Date(2026, 10, 3).toISOString()),
			usage(0, "002-b", new Date(2026, 10, 4).toISOString(), 500),
			usage(50, "003-old", new Date(2026, 8, 1).toISOString()),
		];
		const status = budgetStatus(project, now, usages);
		expect(status.spent).toBe(9.5);
		expect(status.complete).toBe(false);
		expect(status.level).toBe("critical");
		expect(status.tasksOverWarning.map((t) => t.specId)).toEqual(["003-old", "001-a", "002-b"]);
	});

	it("starts a week on Sunday", () => {
		const start = periodStart("weekly", new Date(2026, 10, 14, 12));
		expect(start?.getDay()).toBe(0);
		expect(periodStart("total")).toBeNull();
	});
});

describe("writeTaskBudget", () => {
	it("sets and clears the task's own limit in every spec copy, keeping its metadata", () => {
		const a = path.join(project, "a");
		const b = path.join(project, "b");
		fs.mkdirSync(a);
		fs.mkdirSync(b);
		fs.writeFileSync(path.join(a, "task_metadata.json"), JSON.stringify({ model: "x" }), "utf-8");
		expect(writeTaskBudget([a, b], 7.5)).toBe(2);
		expect(JSON.parse(fs.readFileSync(path.join(a, "task_metadata.json"), "utf-8"))).toEqual({ model: "x", budgetUsd: 7.5 });
		writeTaskBudget([a], -1);
		expect(JSON.parse(fs.readFileSync(path.join(a, "task_metadata.json"), "utf-8"))).toEqual({ model: "x" });
	});
});

describe("backendPauseMessage", () => {
	it("speaks of the task's limit, the project's, or the stall", () => {
		const task = backendPauseMessage(
			{ enabled: true, reason: "budget", budget: { scope: "task", spentUsd: 4.2, limitUsd: 4 } },
			"Add login",
			"fr",
		);
		expect(task?.title).toBe("Tâche en pause : budget atteint");
		expect(task?.body).toContain("4.20 USD");
		const stall = backendPauseMessage(
			{ enabled: true, reason: "budget_stall", budget: { scope: "stall", spentUsd: 3, limitUsd: 2 } },
			"Add login",
			"en",
		);
		expect(stall?.title).toBe("Task paused: no progress");
	});

	it("names the tool the circuit breaker stopped", () => {
		const message = backendPauseMessage(
			{ enabled: true, reason: "tool_loop", breaker: { tool: "Read", repeats: 5, limit: 5 } },
			"Add login",
			"fr",
		);
		expect(message?.title).toBe("Tâche en pause : coupe-circuit");
		expect(message?.body).toContain("a appelé Read 5 fois");
		expect(backendPauseMessage({ enabled: true, reason: "tool_loop" }, "t", "en")).toBeNull();
	});

	it("says why workpilot.policy.yaml stopped the task", () => {
		const hours = backendPauseMessage(
			{
				enabled: true,
				reason: "policy_hours",
				policy: { reason: "policy_hours", timezone: "Europe/Paris", allowedHours: ["08:00-19:00"] },
			},
			"Add login",
			"fr",
		);
		expect(hours?.title).toBe("Tâche en pause : hors des heures permises");
		expect(hours?.body).toContain("08:00-19:00 (Europe/Paris)");
		const noZone = backendPauseMessage(
			{ enabled: true, reason: "policy_hours", policy: { reason: "policy_hours", allowedHours: [] } },
			"t",
			"en",
		);
		expect(noZone?.body).toContain("work  ()");
		const budget = backendPauseMessage(
			{
				enabled: true,
				reason: "policy_budget",
				policy: { reason: "policy_budget", tokensLastHour: 1200.5, maxTokensPerHour: 1000 },
			},
			"Add login",
			"en",
		);
		expect(budget?.title).toBe("Task paused: token budget reached");
		expect(budget?.body).toContain("spent 1200 tokens");
		expect(backendPauseMessage({ enabled: true, reason: "policy_budget" }, "t", "en")).toBeNull();
		expect(
			backendPauseMessage(
				{ enabled: true, reason: "policy_hours", policy: { reason: "policy_budget" } },
				"t",
				"en",
			),
		).toBeNull();
	});

	it("says nothing for the user's own pause", () => {
		expect(backendPauseMessage({ enabled: true }, "t", "en")).toBeNull();
		expect(backendPauseMessage({ enabled: true, reason: "kill_switch" }, "t", "en")).toBeNull();
		expect(backendPauseMessage({ enabled: false, reason: "budget" }, "t", "en")).toBeNull();
	});
});
