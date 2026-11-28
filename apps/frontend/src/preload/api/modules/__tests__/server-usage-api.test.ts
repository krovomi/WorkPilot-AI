/**
 * The usage bridge sends a view's name one way, and the settings on their own
 * channels; the main checks each of them again.
 */
import { describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(async () => null), send: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: ipc }));

import { IPC_CHANNELS } from "../../../../shared/constants/ipc";
import { createServerUsageAPI } from "../server-usage-api";

describe("createServerUsageAPI", () => {
	it("names a view, reads and saves the settings", async () => {
		const api = createServerUsageAPI();
		api.notePageVisit("kanban");
		expect(ipc.send).toHaveBeenCalledWith(IPC_CHANNELS.SERVER_USAGE_PAGE_VISIT, "kanban");
		await api.getUsageSettings();
		expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SERVER_USAGE_GET_SETTINGS);
		const body = { page_activity: true, usage_retention_days: null, page_activity_retention_days: 90 };
		await api.setUsageSettings(body);
		expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SERVER_USAGE_SET_SETTINGS, body);
	});

	it("reads, changes and sends the report, and reads, sets and removes budgets", async () => {
		const api = createServerUsageAPI();
		const settings = {
			enabled: true,
			time: "09:00",
			timezone: "Europe/Paris",
			days: [0],
			recipients: [],
			language: "fr" as const,
			names: true,
			weekly: false,
			monthly: false,
		};
		const budget = { scope: "group" as const, target_id: "g1", monthly_tokens: 10, block: false };
		await api.getReportSettings();
		expect(ipc.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SERVER_USAGE_GET_REPORT_SETTINGS);
		await api.setReportSettings(settings);
		expect(ipc.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SERVER_USAGE_SET_REPORT_SETTINGS, settings);
		await api.getReport("weekly", "2026-11-20");
		expect(ipc.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SERVER_USAGE_REPORT, "weekly", "2026-11-20");
		await api.sendReportNow();
		expect(ipc.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SERVER_USAGE_SEND_REPORT);
		await api.getBudgets();
		expect(ipc.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SERVER_USAGE_BUDGETS);
		await api.setBudget(budget);
		expect(ipc.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SERVER_USAGE_SET_BUDGET, budget);
		await api.removeBudget("b1");
		expect(ipc.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.SERVER_USAGE_REMOVE_BUDGET, "b1");
	});
});
