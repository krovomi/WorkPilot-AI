/**
 * @vitest-environment node
 *
 * IPC of each AI account's spend and budget (ai-account-usage-handlers.ts):
 * the renderer names an existing account and an amount, both checked here;
 * it only ever gets sums back.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const usage = vi.hoisted(() => ({
	snapshot: vi.fn(),
	known: new Map<string, string>(),
	start: vi.fn(),
}));

vi.mock("electron", () => ({ app: { getPath: () => "/unused" }, ipcMain: { handle: vi.fn() } }));
vi.mock("../../app-logger", () => ({ appLog: { warn: vi.fn() } }));
vi.mock("../../ai-accounts/account-usage", () => ({
	accountUsageSnapshot: () => usage.snapshot(),
	knownAccounts: () => usage.known,
	startAccountBudgetWatch: () => usage.start(),
}));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { AccountBudgetStore, setAccountBudgetStoreForTests } from "../../ai-accounts/account-budgets";
import {
	getAiAccountUsage,
	registerAiAccountUsageHandlers,
	setAiAccountBudget,
} from "../ai-account-usage-handlers";

let dir: string;
let store: AccountBudgetStore;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "ai-account-usage-ipc-"));
	store = new AccountBudgetStore(path.join(dir, "budgets.json"));
	setAccountBudgetStoreForTests(store);
	usage.known = new Map([
		["acc-1", "Perso"],
		["claude:work", "Work"],
	]);
	usage.snapshot.mockReset();
	usage.start.mockReset();
});

afterEach(() => {
	setAccountBudgetStoreForTests(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("AI account usage IPC", () => {
	it("registers both channels and starts the budget watch", async () => {
		registerAiAccountUsageHandlers();
		const handle = vi.mocked(ipcMain.handle);
		const handlers = new Map(handle.mock.calls.map(([channel, fn]) => [channel, fn]));
		expect(usage.start).toHaveBeenCalledOnce();
		usage.snapshot.mockReturnValue({ month: "2026-11", accounts: {} });
		const read = handlers.get(IPC_CHANNELS.AI_ACCOUNTS_USAGE) as () => unknown;
		expect(read()).toEqual({ success: true, data: { month: "2026-11", accounts: {} } });
		const set = handlers.get(IPC_CHANNELS.AI_ACCOUNTS_SET_BUDGET) as (
			event: unknown,
			key: unknown,
			amount: unknown,
		) => unknown;
		expect(set({}, "acc-1", 30)).toEqual({ success: true, data: 30 });
	});

	it("answers a short reason when the usage cannot be read", () => {
		usage.snapshot.mockImplementation(() => {
			throw new Error("/secret/path unreadable");
		});
		expect(getAiAccountUsage()).toEqual({ success: false, error: "Usage unreadable" });
	});

	it("sets and removes a budget of an existing account", () => {
		expect(setAiAccountBudget("claude:work", 12.5)).toEqual({ success: true, data: 12.5 });
		expect(store.budgets()).toEqual({ "claude:work": 12.5 });
		expect(setAiAccountBudget("claude:work", 0)).toEqual({ success: true, data: 0 });
		expect(store.budgets()).toEqual({});
	});

	it.each([
		["an unknown account", "acc-9", 10, "Invalid account"],
		["a key that is not a label", "../acc-1", 10, "Invalid account"],
		["a key that is not a string", 7, 10, "Invalid account"],
		["a negative amount", "acc-1", -5, "Invalid amount"],
		["an amount in text", "acc-1", "10", "Invalid amount"],
	])("refuses %s", (_label, key, amount, error) => {
		expect(setAiAccountBudget(key, amount)).toEqual({ success: false, error });
		expect(store.budgets()).toEqual({});
	});

	it("answers a fixed reason for a non-Error refusal", () => {
		const odd = {
			setBudget: () => {
				throw "nope";
			},
		} as unknown as AccountBudgetStore;
		expect(setAiAccountBudget("acc-1", 1, usage.known, odd)).toEqual({ success: false, error: "Refused" });
	});
});
