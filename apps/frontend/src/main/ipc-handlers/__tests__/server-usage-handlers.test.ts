/**
 * The usage channels hand the renderer's arguments, untouched, to
 * server-usage.ts, which checks every one of them; a view opened is one-way
 * and never throws back.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	listeners: new Map<string, (...args: unknown[]) => unknown>(),
	usage: {
		notePageVisit: vi.fn(async () => true),
		getUsageSettings: vi.fn(async () => "read"),
		setUsageSettings: vi.fn(async () => "saved"),
	},
	views: {
		getUsageView: vi.fn(async (...args: unknown[]) => ["view", ...args]),
		getUsagePerson: vi.fn(async (...args: unknown[]) => ["person", ...args]),
		exportUsage: vi.fn(async (...args: unknown[]) => ["export", ...args]),
		getMyUsage: vi.fn(async (...args: unknown[]) => ["mine", ...args]),
		exportMyUsage: vi.fn(async () => ["exportMine"]),
		getUsageNotice: vi.fn(async () => ["notice"]),
		markUsageNoticeSeen: vi.fn(async () => ["seen"]),
		eraseAccount: vi.fn(async (...args: unknown[]) => ["erase", ...args]),
	},
	report: {
		getReportSettings: vi.fn(async () => ["reportSettings"]),
		setReportSettings: vi.fn(async (...args: unknown[]) => ["setReportSettings", ...args]),
		getReport: vi.fn(async (...args: unknown[]) => ["report", ...args]),
		sendReportNow: vi.fn(async () => ["sendNow"]),
		getBudgets: vi.fn(async () => ["budgets"]),
		setBudget: vi.fn(async (...args: unknown[]) => ["setBudget", ...args]),
		removeBudget: vi.fn(async (...args: unknown[]) => ["removeBudget", ...args]),
	},
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
			mocks.handlers.set(channel, handler),
		on: (channel: string, listener: (...args: unknown[]) => unknown) =>
			mocks.listeners.set(channel, listener),
	},
}));
vi.mock("../../server-usage", () => mocks.usage);
vi.mock("../../server-usage-views", () => mocks.views);
vi.mock("../../server-usage-report", () => mocks.report);

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { registerServerUsageHandlers } from "../server-usage-handlers";

describe("usage channels", () => {
	it("pass each argument to the module that checks it", async () => {
		registerServerUsageHandlers();
		mocks.listeners.get(IPC_CHANNELS.SERVER_USAGE_PAGE_VISIT)?.({}, "kanban");
		expect(mocks.usage.notePageVisit).toHaveBeenCalledWith("kanban");
		mocks.usage.notePageVisit.mockRejectedValueOnce(new Error("offline"));
		expect(() => mocks.listeners.get(IPC_CHANNELS.SERVER_USAGE_PAGE_VISIT)?.({}, "x")).not.toThrow();
		expect(await mocks.handlers.get(IPC_CHANNELS.SERVER_USAGE_GET_SETTINGS)?.({})).toBe("read");
		const body = { page_activity: true };
		expect(await mocks.handlers.get(IPC_CHANNELS.SERVER_USAGE_SET_SETTINGS)?.({}, body)).toBe("saved");
		expect(mocks.usage.setUsageSettings).toHaveBeenCalledWith(body);
	});

	it("pass the Usage tab's arguments, untouched, to the module that checks them", async () => {
		registerServerUsageHandlers();
		const call = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)?.({}, ...args);
		expect(await call(IPC_CHANNELS.SERVER_USAGE_VIEW, "summary", { start: "s" })).toEqual([
			"view",
			"summary",
			{ start: "s" },
		]);
		expect(await call(IPC_CHANNELS.SERVER_USAGE_PERSON, "p1", {})).toEqual(["person", "p1", {}]);
		expect(await call(IPC_CHANNELS.SERVER_USAGE_EXPORT, "daily", {})).toEqual(["export", "daily", {}]);
		expect(await call(IPC_CHANNELS.SERVER_USAGE_MINE, {})).toEqual(["mine", {}]);
		expect(await call(IPC_CHANNELS.SERVER_USAGE_EXPORT_MINE)).toEqual(["exportMine"]);
		expect(await call(IPC_CHANNELS.SERVER_USAGE_NOTICE)).toEqual(["notice"]);
		expect(await call(IPC_CHANNELS.SERVER_USAGE_NOTICE_SEEN)).toEqual(["seen"]);
		expect(await call(IPC_CHANNELS.SERVER_USAGE_ERASE_ACCOUNT, "u1", "a@b.c")).toEqual([
			"erase",
			"u1",
			"a@b.c",
		]);
	});

	it("pass the report's and the budgets' arguments, untouched, to the module that checks them", async () => {
		registerServerUsageHandlers();
		const call = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)?.({}, ...args);
		expect(await call(IPC_CHANNELS.SERVER_USAGE_GET_REPORT_SETTINGS)).toEqual(["reportSettings"]);
		expect(await call(IPC_CHANNELS.SERVER_USAGE_SET_REPORT_SETTINGS, { time: "09:00" })).toEqual([
			"setReportSettings",
			{ time: "09:00" },
		]);
		expect(await call(IPC_CHANNELS.SERVER_USAGE_REPORT, "weekly", "2026-11-20")).toEqual([
			"report",
			"weekly",
			"2026-11-20",
		]);
		expect(await call(IPC_CHANNELS.SERVER_USAGE_SEND_REPORT)).toEqual(["sendNow"]);
		expect(await call(IPC_CHANNELS.SERVER_USAGE_BUDGETS)).toEqual(["budgets"]);
		expect(await call(IPC_CHANNELS.SERVER_USAGE_SET_BUDGET, { scope: "group" })).toEqual([
			"setBudget",
			{ scope: "group" },
		]);
		expect(await call(IPC_CHANNELS.SERVER_USAGE_REMOVE_BUDGET, "b1")).toEqual(["removeBudget", "b1"]);
	});
});
