/**
 * The usage report's and the budgets' calls: only settings, kinds, days,
 * scopes and ids within the server's own bounds reach the server; anything
 * else is refused before it leaves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ ok: true, data: "answer" })));
vi.mock("../server-connection", () => ({ authedFetch: fetchMock }));

import {
	budgetOf,
	getBudgets,
	getReport,
	getReportSettings,
	MAX_BUDGET_TOKENS,
	MAX_RECIPIENTS,
	removeBudget,
	reportSettingsOf,
	sendReportNow,
	setBudget,
	setReportSettings,
} from "../server-usage-report";

const ID = "0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3";
const SETTINGS = {
	enabled: true,
	time: "09:00",
	timezone: "Europe/Paris",
	days: [4, 0, 2, 0],
	recipients: [" boss@example.com ", "Boss@Example.com", "team@example.org"],
	language: "fr",
	names: false,
	weekly: true,
	monthly: false,
};
const BUDGET = { scope: "group", target_id: ID, monthly_tokens: 2_000_000, block: true };

beforeEach(() => fetchMock.mockClear());

describe("reportSettingsOf", () => {
	it("keeps sane settings, days sorted once, addresses trimmed once", () => {
		expect(reportSettingsOf(SETTINGS)).toEqual({
			...SETTINGS,
			days: [0, 2, 4],
			recipients: ["boss@example.com", "team@example.org"],
		});
		expect(reportSettingsOf({ ...SETTINGS, recipients: [], timezone: "America/Argentina/Buenos_Aires" }))
			.toMatchObject({ recipients: [], timezone: "America/Argentina/Buenos_Aires" });
	});

	it("refuses anything off", () => {
		const off: Array<Record<string, unknown>> = [
			{ time: "9:00" },
			{ time: "24:00" },
			{ time: 900 },
			{ timezone: "../../etc/passwd" },
			{ timezone: "" },
			{ timezone: "Europe/Paris; rm" },
			{ days: [] },
			{ days: [7] },
			{ days: [0.5] },
			{ days: "0,1" },
			{ days: [0, 1, 2, 3, 4, 5, 6, 0] },
			{ recipients: ["not an address"] },
			{ recipients: ["a@b"] },
			{ recipients: [3] },
			{ recipients: "a@b.c" },
			{ recipients: Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `p${i}@example.com`) },
			{ recipients: [`${"x".repeat(250)}@example.com`] },
			{ language: "de" },
			{ enabled: "yes" },
			{ names: 1 },
			{ weekly: null },
			{ monthly: undefined },
		];
		for (const change of off) expect(reportSettingsOf({ ...SETTINGS, ...change })).toBeNull();
		expect(reportSettingsOf(null)).toBeNull();
		expect(reportSettingsOf([SETTINGS])).toBeNull();
	});
});

describe("report calls", () => {
	it("read and change the settings, read a report, send one now", async () => {
		await getReportSettings();
		expect(fetchMock).toHaveBeenLastCalledWith("/admin/usage/report/settings", "GET");
		await setReportSettings(SETTINGS);
		expect(fetchMock).toHaveBeenLastCalledWith("/admin/usage/report/settings", "PUT", {
			...SETTINGS,
			days: [0, 2, 4],
			recipients: ["boss@example.com", "team@example.org"],
		});
		await getReport("daily");
		expect(fetchMock).toHaveBeenLastCalledWith("/admin/usage/report?kind=daily", "GET");
		await getReport("monthly", "");
		expect(fetchMock).toHaveBeenLastCalledWith("/admin/usage/report?kind=monthly", "GET");
		await getReport("weekly", "2026-11-20");
		expect(fetchMock).toHaveBeenLastCalledWith(
			"/admin/usage/report?kind=weekly&day=2026-11-20",
			"GET",
		);
		await sendReportNow();
		expect(fetchMock).toHaveBeenLastCalledWith("/admin/usage/report/send", "POST");
	});

	it("send nothing for settings, a kind or a day that does not read", async () => {
		expect(await setReportSettings({ ...SETTINGS, time: "noon" })).toEqual({
			ok: false,
			error: "Invalid report settings",
		});
		expect(await getReport("yearly")).toEqual({ ok: false, error: "Invalid report kind" });
		expect(await getReport(1)).toEqual({ ok: false, error: "Invalid report kind" });
		expect(await getReport("daily", "20/11/2026")).toEqual({ ok: false, error: "Invalid report day" });
		expect(await getReport("daily", "2026-11-20&kind=x")).toEqual({
			ok: false,
			error: "Invalid report day",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("budget calls", () => {
	it("keeps a sane budget", () => {
		expect(budgetOf(BUDGET)).toEqual(BUDGET);
		expect(budgetOf({ ...BUDGET, scope: "person", monthly_tokens: MAX_BUDGET_TOKENS })).toMatchObject({
			scope: "person",
		});
	});

	it("refuses a scope, a target, an amount or a flag that does not read", () => {
		const off: Array<Record<string, unknown>> = [
			{ scope: "org" },
			{ scope: undefined },
			{ target_id: "../users" },
			{ target_id: "" },
			{ target_id: 42 },
			{ monthly_tokens: 0 },
			{ monthly_tokens: 1.5 },
			{ monthly_tokens: MAX_BUDGET_TOKENS + 1 },
			{ monthly_tokens: "100" },
			{ block: "true" },
		];
		for (const change of off) expect(budgetOf({ ...BUDGET, ...change })).toBeNull();
		expect(budgetOf(null)).toBeNull();
		expect(budgetOf([BUDGET])).toBeNull();
	});

	it("read, set and remove budgets, and nothing leaves for an id off", async () => {
		await getBudgets();
		expect(fetchMock).toHaveBeenLastCalledWith("/admin/usage/budgets", "GET");
		await setBudget(BUDGET);
		expect(fetchMock).toHaveBeenLastCalledWith("/admin/usage/budgets", "PUT", BUDGET);
		await removeBudget(ID);
		expect(fetchMock).toHaveBeenLastCalledWith(`/admin/usage/budgets/${ID}`, "DELETE");
		fetchMock.mockClear();
		expect(await setBudget({ ...BUDGET, scope: "everyone" })).toEqual({
			ok: false,
			error: "Invalid budget",
		});
		expect(await removeBudget("../settings")).toEqual({ ok: false, error: "Invalid budget" });
		expect(await removeBudget(7)).toEqual({ ok: false, error: "Invalid budget" });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
