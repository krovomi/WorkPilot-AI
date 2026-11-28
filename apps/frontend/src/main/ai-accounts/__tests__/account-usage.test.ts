/**
 * @vitest-environment node
 *
 * Each AI account's month (account-usage.ts): sessions that name the account,
 * this month only, across projects; alerts at 80 % then 100 %, once each.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
	profiles: [] as { id: string; name: string }[],
	profilesThrow: false,
	projects: [] as { id: string; path: string }[],
	usages: new Map<string, unknown[]>(),
	announce: vi.fn(),
}));

vi.mock("electron", () => ({ app: { getPath: () => "/unused" } }));
vi.mock("../../secret-storage", () => ({
	encryptSecret: (value: string) => `enc:${value}`,
	decryptSecret: (stored: string) => stored.slice(4),
}));
vi.mock("../../claude-profile-manager", () => ({
	getClaudeProfileManager: () => ({
		getSettings: () => {
			if (world.profilesThrow) throw new Error("unreadable");
			return { profiles: world.profiles };
		},
	}),
}));
vi.mock("../../project-store", () => ({
	projectStore: { getProjects: () => world.projects },
}));
vi.mock("../../workspace-ledgers", () => ({
	readUsages: (projectPath: string) => world.usages.get(projectPath) ?? [],
}));
vi.mock("../../notification-service", () => ({
	notificationService: { announce: (...args: unknown[]) => world.announce(...args) },
}));
vi.mock("../../app-language", () => ({ getAppLanguage: () => "fr" }));

import type { LedgerUsage } from "../../workspace-ledgers";
import { AccountBudgetStore, setAccountBudgetStoreForTests } from "../account-budgets";
import {
	accountUsageSnapshot,
	alertText,
	BUDGET_CHECK_MS,
	checkAccountBudgets,
	knownAccounts,
	monthOf,
	monthTotals,
	startAccountBudgetWatch,
	stopAccountBudgetWatch,
} from "../account-usage";
import { AiAccountStore, setAiAccountStoreForTests } from "../ai-accounts";

const NOW = new Date(2026, 10, 20, 12, 0, 0);

function usage(account: string | undefined, cost: number, when = NOW, tokens = 100): LedgerUsage {
	return {
		provider: "openai",
		model: "gpt-5",
		input_tokens: tokens,
		output_tokens: tokens / 2,
		cost,
		phase: "coding",
		agent_type: "coder",
		spec_id: "001",
		timestamp: when.toISOString(),
		...(account ? { account_id: account } : {}),
	};
}

let dir: string;
let budgets: AccountBudgetStore;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "account-usage-"));
	budgets = new AccountBudgetStore(path.join(dir, "budgets.json"));
	setAccountBudgetStoreForTests(budgets);
	setAiAccountStoreForTests(new AiAccountStore(path.join(dir, "ai-accounts.json")));
	world.profiles = [{ id: "work", name: "Claude Work" }];
	world.profilesThrow = false;
	world.projects = [
		{ id: "p1", path: "/p1" },
		{ id: "p2", path: "/p2" },
	];
	world.usages = new Map();
	world.announce.mockReset();
});

afterEach(() => {
	setAccountBudgetStoreForTests(null);
	setAiAccountStoreForTests(null);
	stopAccountBudgetWatch();
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

describe("monthTotals", () => {
	it("adds up this month's sessions of each account, across projects", () => {
		const read = (p: string) =>
			p === "/p1"
				? [
						usage("acc-1", 1.5),
						usage("acc-1", 0.5, new Date(2026, 10, 1, 0, 0, 1)),
						usage("acc-1", 9, new Date(2026, 9, 31, 23, 0, 0)),
						usage(undefined, 4),
						{ ...usage("acc-1", 1), timestamp: "not a date" },
					]
				: [usage("acc-1", 2), usage("claude:work", 0, NOW, 40)];
		const totals = monthTotals(world.projects, { "acc-1": 5 }, NOW, read);
		const acc = totals.get("acc-1");
		expect(acc?.usage).toMatchObject({
			costUsd: 4,
			inputTokens: 300,
			outputTokens: 150,
			sessions: 3,
			complete: true,
			budgetUsd: 5,
			level: "warning",
		});
		expect([...(acc?.byProject ?? [])]).toEqual([
			["p1", 2],
			["p2", 2],
		]);
		expect(totals.get("claude:work")?.usage).toMatchObject({ complete: false, level: "none" });
	});

	it("lists an account with a budget and no spend yet", () => {
		const totals = monthTotals([], { "acc-2": 10 }, NOW, () => []);
		expect(totals.get("acc-2")?.usage).toMatchObject({ costUsd: 0, level: "ok" });
	});

	it("says exceeded at the budget", () => {
		const totals = monthTotals(world.projects, { a: 2 }, NOW, () => [usage("a", 1)]);
		expect(totals.get("a")?.usage.level).toBe("exceeded");
	});
});

describe("snapshot", () => {
	it("keeps only the accounts that exist now", () => {
		world.usages.set("/p1", [usage("claude:work", 1), usage("gone", 3)]);
		const snapshot = accountUsageSnapshot(NOW);
		expect(snapshot.month).toBe("2026-11");
		expect(Object.keys(snapshot.accounts)).toEqual(["claude:work"]);
	});

	it("names saved accounts and Claude sign-ins, and survives an unreadable source", () => {
		const store = new AiAccountStore(path.join(dir, "named.json"));
		const saved = store.save({ provider: "openai", name: "Perso", apiKey: "sk-test-0000" });
		setAiAccountStoreForTests(store);
		expect(knownAccounts()).toEqual(
			new Map([
				[saved.id, "Perso"],
				["claude:work", "Claude Work"],
			]),
		);
		world.profilesThrow = true;
		setAiAccountStoreForTests({
			list: () => {
				throw new Error("unreadable");
			},
		} as unknown as AiAccountStore);
		expect(knownAccounts().size).toBe(0);
	});

	it("formats months on two digits", () => {
		expect(monthOf(new Date(2026, 0, 3))).toBe("2026-01");
	});
});

describe("alerts", () => {
	const known = new Map([["acc-1", "Perso"]]);

	it("writes the alert in the app's language", () => {
		const month = { key: "acc-1", costUsd: 41.5, budgetUsd: 50 } as never;
		expect(alertText("warning", month, "Perso", "fr")).toEqual({
			title: "Budget du compte IA à 83 %",
			body: "Perso a dépensé 41,50 $ sur ses 50,00 $ ce mois-ci.",
		});
		expect(alertText("exceeded", month, "Perso", "en").body).toBe(
			"Perso spent $41.50 this month, over its $50.00 budget.",
		);
	});

	it("does nothing without a budget", () => {
		world.usages.set("/p1", [usage("acc-1", 100)]);
		expect(checkAccountBudgets(NOW, world.projects, budgets, known, world.announce)).toBe(0);
		expect(world.announce).not.toHaveBeenCalled();
	});

	it("warns at 80 % once, then at the budget once, in the project that spent most", () => {
		budgets.setBudget("acc-1", 10);
		world.usages.set("/p1", [usage("acc-1", 2)]);
		world.usages.set("/p2", [usage("acc-1", 6.5)]);
		const check = () => checkAccountBudgets(NOW, world.projects, budgets, known, world.announce, "en");

		expect(check()).toBe(1);
		expect(world.announce).toHaveBeenLastCalledWith("p2", {
			title: "AI account budget at 85 %",
			body: "Perso spent $8.50 of its $10.00 this month.",
		});
		expect(check()).toBe(0);

		world.usages.set("/p1", [usage("acc-1", 4)]);
		expect(check()).toBe(1);
		expect(world.announce).toHaveBeenLastCalledWith("p2", expect.objectContaining({ title: "AI account budget reached" }));
		expect(check()).toBe(0);
		expect(world.announce).toHaveBeenCalledTimes(2);
	});

	it("sends only the budget-reached alert when the budget is passed at once", () => {
		budgets.setBudget("acc-1", 1);
		world.usages.set("/p1", [usage("acc-1", 3)]);
		world.usages.set("/p2", [usage("acc-1", 0.5)]);
		expect(checkAccountBudgets(NOW, world.projects, budgets, known, world.announce)).toBe(1);
		expect(world.announce).toHaveBeenCalledWith("p1", expect.anything());
		expect(budgets.wasSent("acc-1", "2026-11", "warning")).toBe(true);
	});

	it("skips an account that no longer exists, or one under its warning, or one with no spend", () => {
		budgets.setBudget("gone", 1);
		budgets.setBudget("acc-1", 100);
		budgets.setBudget("claude:work", 0.01);
		world.usages.set("/p1", [usage("gone", 5), usage("acc-1", 1)]);
		const names = new Map([...known, ["claude:work", "W"]]);
		expect(checkAccountBudgets(NOW, world.projects, budgets, names, world.announce)).toBe(0);
	});

	it("uses the app's channels and language by default", () => {
		budgets.setBudget("claude:work", 1);
		world.usages.set("/p1", [usage("claude:work", 1)]);
		expect(checkAccountBudgets(NOW)).toBe(1);
		expect(world.announce).toHaveBeenCalledWith("p1", expect.objectContaining({ title: "Budget du compte IA atteint" }));
	});
});

describe("watch", () => {
	it("checks a minute after start, then on every interval, and starts once", () => {
		vi.useFakeTimers();
		budgets.setBudget("claude:work", 1);
		world.usages.set("/p1", [usage("claude:work", 0.9)]);
		startAccountBudgetWatch();
		startAccountBudgetWatch();
		vi.advanceTimersByTime(60 * 1000);
		expect(world.announce).toHaveBeenCalledTimes(1);
		world.usages.set("/p1", [usage("claude:work", 2)]);
		vi.advanceTimersByTime(BUDGET_CHECK_MS);
		expect(world.announce).toHaveBeenCalledTimes(2);
	});

	it("keeps going when a check fails", () => {
		vi.useFakeTimers();
		setAccountBudgetStoreForTests({
			budgets: () => {
				throw new Error("disk");
			},
		} as unknown as AccountBudgetStore);
		startAccountBudgetWatch();
		expect(() => vi.advanceTimersByTime(60 * 1000)).not.toThrow();
	});
});
