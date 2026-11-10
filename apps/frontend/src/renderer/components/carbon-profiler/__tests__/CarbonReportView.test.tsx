/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CarbonReport } from "../../../../shared/types/carbon-profiler";
import { useCarbonProfilerStore } from "../../../stores/carbon-profiler-store";
import { CarbonReportView } from "../CarbonReportView";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
	}),
}));

const report: CarbonReport = {
	month: "2026-11",
	records: [],
	recordCount: 3,
	totalKwh: 0.05,
	totalCo2G: 18.1,
	periodStart: "2026-11-05T10:00:00+00:00",
	periodEnd: "2026-11-06T11:00:00+00:00",
	byProvider: { anthropic: 18 },
	byModel: { "claude-opus-4-1": 16.9 },
	byPhase: { qa_review: { co2G: 16.9, kwh: 0.04, calls: 1 } },
	byTask: {},
	months: [
		{ month: "2026-10", co2G: 10, kwh: 0.02 },
		{ month: "2026-11", co2G: 18.1, kwh: 0.05 },
	],
	carKm: 0.15,
	advice: [{ code: "review_on_fast", share: 100, saving: 90 }],
	unknownHosts: ["mistral"],
	generatedAt: "2026-11-10T00:00:00+00:00",
	summary: "",
	hasLedger: true,
	budget: {
		month: "2026-11",
		usedG: 18.1,
		budgetG: 10,
		percent: 181,
		alertPercent: 80,
		state: "exceeded",
		degrade: true,
		degraded: true,
	},
	config: {
		region: "fr",
		monthlyBudgetKg: 0.01,
		alertPercent: 80,
		degrade: true,
		localPowerW: 150,
		cpuOnly: false,
		factors: {},
		regions: ["fr", "world"],
	},
};

const api = {
	runCarbonProfilerScan: vi.fn(async () => report),
	cancelCarbonProfilerScan: vi.fn(async () => true),
	saveCarbonConfig: vi.fn(async () => report.config),
	exportCarbonReport: vi.fn(async () => "/tmp/carbon.md"),
};

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockClear();
	(globalThis as unknown as { electronAPI: typeof api }).electronAPI = api;
	useCarbonProfilerStore.setState({ phase: "idle", report: null, error: null, month: "2026-11", exported: null });
});

describe("CarbonReportView", () => {
	it("reads the month's report, with the budget, the advice and the degraded mode", async () => {
		render(<CarbonReportView projectPath="/p" />);
		await waitFor(() => expect(screen.getByText("budget.states.exceeded")).toBeTruthy());
		expect(api.runCarbonProfilerScan).toHaveBeenCalledWith({ projectPath: "/p", month: "2026-11", backfill: false });
		expect(screen.getByText("budget.degraded")).toBeTruthy();
		expect(screen.getByText('advice.review_on_fast {"share":100,"saving":90}')).toBeTruthy();
		expect(screen.getByText(/unknownHosts/)).toBeTruthy();
	});

	it("exports the chosen month and saves checked settings", async () => {
		render(<CarbonReportView projectPath="/p" />);
		await waitFor(() => expect(screen.getByText("carbonProfiler:export.formats.md")).toBeTruthy());
		await act(async () => fireEvent.click(screen.getByText("carbonProfiler:export.formats.md")));
		expect(api.exportCarbonReport).toHaveBeenCalledWith("/p", "2026-11", "md");

		await act(async () => fireEvent.click(screen.getByText("settings.save")));
		expect(api.saveCarbonConfig).toHaveBeenCalledWith("/p", {
			region: "fr",
			monthlyBudgetKg: 0.01,
			alertPercent: 80,
			degrade: true,
			localPowerW: 150,
			cpuOnly: false,
			factors: {},
		});
	});
});
