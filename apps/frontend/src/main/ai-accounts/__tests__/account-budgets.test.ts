/**
 * @vitest-environment node
 *
 * The monthly budget of each AI account and the alerts already sent
 * (account-budgets.ts): amounts checked, one alert per threshold and month,
 * an odd file read as empty.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/unused-user-data" } }));

import {
	AccountBudgetStore,
	accountBudgetStore,
	budgetAmount,
	setAccountBudgetStoreForTests,
} from "../account-budgets";

let dir: string;
let file: string;
let store: AccountBudgetStore;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "account-budgets-"));
	file = path.join(dir, "config", "ai-account-budgets.json");
	store = new AccountBudgetStore(file);
});

afterEach(() => {
	setAccountBudgetStoreForTests(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("budgetAmount", () => {
	it.each([
		[20, 20],
		[0, 0],
		[12.345, 12.35],
		[1_000_000, 1_000_000],
	])("keeps %s as %s", (input, expected) => {
		expect(budgetAmount(input)).toBe(expected);
	});

	it.each([[-1], [1_000_001], [Number.NaN], [Number.POSITIVE_INFINITY], ["20"], [null]])(
		"refuses %s",
		(input) => {
			expect(budgetAmount(input)).toBeNull();
		},
	);
});

describe("AccountBudgetStore", () => {
	it("starts empty without a file", () => {
		expect(store.budgets()).toEqual({});
		expect(store.wasSent("acc-1", "2026-11", "warning")).toBe(false);
	});

	it("saves a budget in a 0600 file and removes it with 0", () => {
		expect(store.setBudget("acc-1", 50)).toBe(50);
		expect(store.budgets()).toEqual({ "acc-1": 50 });
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(store.setBudget("acc-1", 0)).toBe(0);
		expect(store.budgets()).toEqual({});
	});

	it("refuses an odd key or amount", () => {
		expect(() => store.setBudget("../x", 10)).toThrow("Invalid account");
		expect(() => store.setBudget("acc-1", -3)).toThrow("Invalid amount");
	});

	it("refuses a budget past the bound, but updates an existing one", () => {
		const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`a${i}`, 1]));
		writeFileSync(path.join(dir, "full.json"), JSON.stringify({ budgets: many }), "utf-8");
		const full = new AccountBudgetStore(path.join(dir, "full.json"));
		expect(() => full.setBudget("new-one", 5)).toThrow("Too many budgets");
		expect(full.setBudget("a1", 7)).toBe(7);
	});

	it("records each alert once per month", () => {
		store.markSent("acc-1", "2026-11", "warning");
		store.markSent("acc-1", "2026-11", "warning");
		expect(store.wasSent("acc-1", "2026-11", "warning")).toBe(true);
		expect(store.wasSent("acc-1", "2026-11", "exceeded")).toBe(false);
		expect(store.wasSent("acc-1", "2026-12", "warning")).toBe(false);
		const saved = JSON.parse(readFileSync(file, "utf-8"));
		expect(saved.alerts["acc-1"]).toEqual({ month: "2026-11", sent: ["warning"] });
		store.markSent("acc-1", "2026-12", "exceeded");
		expect(store.wasSent("acc-1", "2026-11", "warning")).toBe(false);
	});

	it("starts the month's alerts over when the budget changes", () => {
		store.setBudget("acc-1", 10);
		store.markSent("acc-1", "2026-11", "warning");
		store.setBudget("acc-1", 20);
		expect(store.wasSent("acc-1", "2026-11", "warning")).toBe(false);
	});

	it("forgets an account's budget and alerts, and leaves the file alone otherwise", () => {
		store.setBudget("acc-1", 10);
		store.markSent("acc-1", "2026-11", "warning");
		store.forget("acc-1");
		expect(store.budgets()).toEqual({});
		expect(store.wasSent("acc-1", "2026-11", "warning")).toBe(false);
		store.forget("never-there");
	});

	it("reads an unreadable or hostile file as empty, keeping what is valid", () => {
		writeFileSync(path.join(dir, "bad.json"), "{nope", "utf-8");
		expect(new AccountBudgetStore(path.join(dir, "bad.json")).budgets()).toEqual({});

		writeFileSync(
			path.join(dir, "mixed.json"),
			JSON.stringify({
				budgets: { good: 5, "bad key": 5, neg: -1, text: "9" },
				alerts: {
					good: { month: "2026-11", sent: ["warning", "other"] },
					"bad key": { month: "2026-11", sent: [] },
					month: { month: "november", sent: [] },
					list: { month: "2026-11", sent: "warning" },
					empty: null,
				},
			}),
			"utf-8",
		);
		const mixed = new AccountBudgetStore(path.join(dir, "mixed.json"));
		expect(mixed.budgets()).toEqual({ good: 5 });
		expect(mixed.wasSent("good", "2026-11", "warning")).toBe(true);
		expect(mixed.wasSent("list", "2026-11", "warning")).toBe(false);

		writeFileSync(path.join(dir, "null.json"), "null", "utf-8");
		expect(new AccountBudgetStore(path.join(dir, "null.json")).budgets()).toEqual({});
	});

	it("the app's store lives under userData/config and can be replaced", () => {
		const appStore = accountBudgetStore();
		expect(appStore).toBe(accountBudgetStore());
		setAccountBudgetStoreForTests(store);
		expect(accountBudgetStore()).toBe(store);
	});
});
