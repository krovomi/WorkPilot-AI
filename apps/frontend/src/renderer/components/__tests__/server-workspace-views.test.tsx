/**
 * The workspace views of a server project read the server, by the project's
 * id: never its mirror, never the local backend, never this computer's files.
 * A project of this computer keeps reading its own folder.
 */

import { render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../stores/project-store";
import { AnalyticsDashboard } from "../AnalyticsDashboard";
import { CostEstimator } from "../CostEstimator";
import { DashboardMetrics } from "../DashboardMetrics";
import { SessionHistory } from "../SessionHistory";

const MIRROR = "/data/server-boards/abc/p-1";

const serverProject = {
	id: "p-1",
	name: "Shop",
	path: MIRROR,
	remote: { repoUrl: "https://github.com/acme/shop.git", defaultBranch: "main", role: "viewer" },
} as unknown as Project;

const localProject = {
	id: "local-1",
	name: "Mine",
	path: "/home/me/mine",
} as unknown as Project;

const summary = {
	total_cost: 1.25,
	cost_by_provider: { anthropic: 1.25 },
	cost_by_model: { "anthropic/sonnet": 1.25 },
	total_tokens: 300,
	tokens_input: 200,
	tokens_output: 100,
	period_days: 2,
	daily_avg: 0.625,
	trend_pct: 0,
};

const snapshot = {
	tasks_by_status: { completed: 1, in_progress: 2 },
	avg_completion_by_complexity: {},
	qa_first_pass_rate: 50,
	qa_avg_score: 0.75,
	total_tokens: 300,
	tokens_by_provider: { anthropic: 300 },
	total_cost: 1.25,
	cost_by_model: { "anthropic/sonnet": 1.25 },
	merge_auto_count: 1,
	merge_manual_count: 0,
};

const api = {
	getServerCostSummary: vi.fn(),
	getServerDashboardSnapshot: vi.fn(),
	getServerSessions: vi.fn(),
	getCostSummary: vi.fn(),
	getCostBudget: vi.fn(),
	getDashboardSnapshot: vi.fn(),
	onCostsUpdated: vi.fn(() => () => undefined),
	onDashboardSnapshotUpdated: vi.fn(() => () => undefined),
};
const fetchMock = vi.fn();

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockClear();
	api.getServerCostSummary.mockResolvedValue({ success: true, data: summary });
	api.getServerDashboardSnapshot.mockResolvedValue({ success: true, data: snapshot });
	api.getServerSessions.mockResolvedValue({
		success: true,
		data: [
			{
				session_id: "r-1",
				kind: "run",
				status: "completed",
				started_at: "2026-10-30T10:00:00+00:00",
				task_title: "001-login",
				task_id: "001-login",
				phase: "build",
				started_by: "Ada",
				tokens_used: 1500,
				cost: 0.5,
			},
		],
	});
	api.getCostSummary.mockResolvedValue({ success: true, summary });
	api.getCostBudget.mockResolvedValue({ success: false, error: "No budget configured" });
	api.getDashboardSnapshot.mockResolvedValue({ success: true, snapshot });
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
		...(globalThis as unknown as { electronAPI?: object }).electronAPI,
		...api,
	};
	useProjectStore.setState({ projects: [serverProject, localProject] });
});

afterEach(() => {
	vi.unstubAllGlobals();
	useProjectStore.setState({ projects: [] });
});

describe("a server project's workspace views", () => {
	it("the session history lists its runs from the server, not the local backend", async () => {
		render(<SessionHistory projectId="p-1" />);
		expect(await screen.findByText("001-login")).toBeInTheDocument();
		expect(screen.getByText("build")).toBeInTheDocument();
		expect(screen.getByText("by Ada")).toBeInTheDocument();
		expect(
			screen.getByText("The runs and jobs of this project on the server, for the whole team"),
		).toBeInTheDocument();
		expect(api.getServerSessions).toHaveBeenCalledWith("p-1");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("the dashboard reads the server, never the mirror", async () => {
		render(<DashboardMetrics projectPath={MIRROR} />);
		await waitFor(() => expect(api.getServerDashboardSnapshot).toHaveBeenCalledWith("p-1"));
		expect(
			await screen.findByText("Computed by the server from this project's cards and runs"),
		).toBeInTheDocument();
		expect(api.getDashboardSnapshot).not.toHaveBeenCalled();
		expect(api.onDashboardSnapshotUpdated).not.toHaveBeenCalled();
	});

	it("the analytics and the costs read the server, and ask for no budget", async () => {
		render(<AnalyticsDashboard projectPath={MIRROR} />);
		await waitFor(() => expect(api.getServerCostSummary).toHaveBeenCalledWith("p-1"));
		expect(api.getServerDashboardSnapshot).toHaveBeenCalledWith("p-1");
		render(<CostEstimator projectPath={MIRROR} />);
		await waitFor(() => expect(api.getServerCostSummary).toHaveBeenCalledTimes(2));
		expect(api.getCostSummary).not.toHaveBeenCalled();
		expect(api.getCostBudget).not.toHaveBeenCalled();
		expect(api.getDashboardSnapshot).not.toHaveBeenCalled();
	});

	it("a project of this computer still reads its own folder", async () => {
		render(<CostEstimator projectPath="/home/me/mine" />);
		await waitFor(() => expect(api.getCostSummary).toHaveBeenCalledWith("/home/me/mine"));
		expect(api.getCostBudget).toHaveBeenCalledWith("/home/me/mine");
		expect(api.getServerCostSummary).not.toHaveBeenCalled();
	});
});
