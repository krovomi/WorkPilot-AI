/**
 * Each AI account's month in the renderer: what the main process adds up, a
 * failure leaving the accounts usable without figures, a refused budget kept
 * as a short reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usageOf, useAiAccountUsageStore } from "../ai-account-usage-store";

const MONTH = {
	key: "acc-1",
	costUsd: 2,
	inputTokens: 10,
	outputTokens: 5,
	sessions: 1,
	complete: true,
	budgetUsd: 10,
	level: "ok" as const,
};

const bridge = { getAiAccountUsage: vi.fn(), setAiAccountBudget: vi.fn() };

beforeEach(() => {
	for (const fn of Object.values(bridge)) fn.mockReset();
	bridge.getAiAccountUsage.mockResolvedValue({
		success: true,
		data: { month: "2026-11", accounts: { "acc-1": MONTH } },
	});
	useAiAccountUsageStore.setState({ month: "", accounts: {}, loaded: false });
	(globalThis as { electronAPI?: unknown }).electronAPI = bridge;
});

afterEach(() => {
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("useAiAccountUsageStore", () => {
	it("loads the month of each account", async () => {
		await useAiAccountUsageStore.getState().load();
		expect(useAiAccountUsageStore.getState()).toMatchObject({
			month: "2026-11",
			accounts: { "acc-1": MONTH },
			loaded: true,
		});
	});

	it("stays usable when the figures cannot be read", async () => {
		bridge.getAiAccountUsage.mockResolvedValueOnce({ success: false, error: "no" });
		await useAiAccountUsageStore.getState().load();
		expect(useAiAccountUsageStore.getState()).toMatchObject({ accounts: {}, loaded: true });
		bridge.getAiAccountUsage.mockRejectedValueOnce(new Error("gone"));
		await useAiAccountUsageStore.getState().load();
		expect(useAiAccountUsageStore.getState().loaded).toBe(true);
	});

	it("sets a budget, then reads the month again", async () => {
		bridge.setAiAccountBudget.mockResolvedValueOnce({ success: true, data: 10 });
		expect(await useAiAccountUsageStore.getState().setBudget("acc-1", 10)).toBeNull();
		expect(bridge.setAiAccountBudget).toHaveBeenCalledWith("acc-1", 10);
		expect(bridge.getAiAccountUsage).toHaveBeenCalled();
		bridge.setAiAccountBudget.mockResolvedValueOnce({ success: false, error: "Invalid amount" });
		expect(await useAiAccountUsageStore.getState().setBudget("acc-1", -1)).toBe("Invalid amount");
		bridge.setAiAccountBudget.mockResolvedValueOnce({ success: false });
		expect(await useAiAccountUsageStore.getState().setBudget("acc-1", -1)).toBe("Refused");
	});

	it("gives an account with nothing recorded an empty month", () => {
		expect(usageOf({ "acc-1": MONTH }, "acc-1")).toBe(MONTH);
		expect(usageOf({}, "acc-2")).toMatchObject({ key: "acc-2", costUsd: 0, level: "none" });
	});
});
