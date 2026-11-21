/** @vitest-environment jsdom */
/**
 * The longevity score of the project, and the health of the agents that ran
 * its Kanban tasks.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentHealthPanel } from "../AgentHealthPanel";
import { LongevityPanel } from "../LongevityPanel";
import { type Api, deferred, openWorld } from "./phase35-world";

let api: Api;
beforeEach(async () => {
	api = await openWorld();
});
afterEach(cleanup);

const REPORT = {
	project_path: "/work/shop",
	score: 64.25,
	grade: "C" as const,
	penalties: { todo_fixme: 3.5, mystery_signal: 1 },
	bonuses: { low_coverage: 2, trend: -0.5 },
	summary: { loc: 12345, total_debt_items: 9, by_kind: {} },
	projection: {
		weeks_observed: 4,
		current_score: 64.25,
		projected_score_in_6_months: 58.04,
		projected_grade_in_6_months: "D" as const,
		direction: "degrading" as const,
		weekly_delta: -0.3,
	},
	riskiest_files: [{ file_path: "src/Orders.cs", items: 4, total_cost: 7.25, kinds: [] }],
};

describe("LongevityPanel", () => {
	it("scores the project and shows its penalties, bonuses, projection and riskiest files", async () => {
		api.scoreLongevity.mockResolvedValue({ success: true, report: REPORT });
		render(<LongevityPanel projectPath="/work/shop" />);
		expect(screen.getByText("No data yet — run the analysis to see results.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Compute score" }));
		expect(await screen.findByText("64.3")).toBeInTheDocument();
		expect(api.scoreLongevity).toHaveBeenCalledWith("/work/shop");
		expect(screen.getByText("Grade C")).toBeInTheDocument();
		expect(screen.getByText(/Lines of code: 12,345/)).toBeInTheDocument();
		expect(screen.getByText("TODO / FIXME")).toBeInTheDocument();
		expect(screen.getByText("−3.50")).toBeInTheDocument();
		// A signal the app has no name for keeps the backend's id.
		expect(screen.getByText("mystery_signal")).toBeInTheDocument();
		expect(screen.getByText("Low test coverage")).toBeInTheDocument();
		expect(screen.getByText("+2.00")).toBeInTheDocument();
		expect(screen.getByText("-0.50")).toBeInTheDocument();
		expect(screen.getByText("degrading")).toBeInTheDocument();
		expect(screen.getByText(/58\.0 \(\s*D\)/)).toBeInTheDocument();
		expect(screen.getByText("src/Orders.cs")).toBeInTheDocument();
		expect(screen.getByText("4 items · cost 7.3")).toBeInTheDocument();
	});

	it("says running while it scores, and shows a report with nothing to list", async () => {
		const answer = deferred<unknown>();
		api.scoreLongevity.mockReturnValue(answer.promise);
		render(<LongevityPanel projectPath="/work/shop" />);
		fireEvent.click(screen.getByRole("button", { name: "Compute score" }));
		expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
		await act(async () =>
			answer.resolve({
				success: true,
				report: { ...REPORT, bonuses: {}, projection: null, riskiest_files: [] },
			}),
		);
		expect(screen.getByText("—")).toBeInTheDocument();
		expect(screen.queryByText("6-month projection")).not.toBeInTheDocument();
		expect(screen.queryByText("Riskiest files")).not.toBeInTheDocument();
	});

	it("shows the backend's refusal", async () => {
		api.scoreLongevity.mockResolvedValue({ success: false, error: "project_path is required" });
		render(<LongevityPanel projectPath="/work/shop" />);
		fireEvent.click(screen.getByRole("button", { name: "Compute score" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Project path is required");
	});
});

const SCORE = {
	agent_name: "coder:openai:gpt-5",
	role: "coder" as const,
	provider: "openai",
	model: "gpt-5",
	score: 91.4,
	status: "burned_out" as const,
	success_rate: 0.95,
	error_rate: 0.05,
	retry_rate: 0.1,
	slowness_ratio: 1.234,
	trend: "improving" as const,
	runs_in_window: 7,
	actions: ["throttle", "brand_new_action"],
	diagnostics: {},
};

describe("AgentHealthPanel", () => {
	it("scores the project's agents with their rates, trend and actions", async () => {
		api.scoreProjectAgentHealth.mockResolvedValue({
			success: true,
			tasks_read: 1,
			min_runs: 3,
			scores: [SCORE, { ...SCORE, agent_name: "qa:-:-", role: "qa", provider: "", model: "", actions: ["none"] }],
			pending: [],
		});
		render(<AgentHealthPanel projectPath="/work/shop" />);
		expect(await screen.findByText("Coder")).toBeInTheDocument();
		expect(screen.getByText("Read from 1 task of the project (finished planning, coding and QA).")).toBeInTheDocument();
		expect(screen.getByText("openai · gpt-5")).toBeInTheDocument();
		expect(screen.getAllByText("burned out")).toHaveLength(2);
		expect(screen.getAllByText("7 runs · improving")).toHaveLength(2);
		expect(screen.getAllByText("Success rate: 95%")).toHaveLength(2);
		expect(screen.getAllByText("Slowness ratio: 1.23×")).toHaveLength(2);
		expect(screen.getByText("Slow down dispatch")).toBeInTheDocument();
		expect(screen.getByText("brand_new_action")).toBeInTheDocument();
		// "none" is not an action to take: the QA row lists none.
		expect(screen.getAllByText("Recommended actions:")).toHaveLength(1);
		expect(screen.getByText("model not named in the logs")).toBeInTheDocument();
		expect(screen.queryByText(/Not enough phases/)).not.toBeInTheDocument();
	});

	it("says when no phase has finished yet, and scores again on demand", async () => {
		api.scoreProjectAgentHealth.mockResolvedValue({
			success: true,
			tasks_read: 0,
			min_runs: 3,
			scores: [],
			pending: [],
		});
		render(<AgentHealthPanel projectPath="/work/shop" />);
		expect(await screen.findByText("No finished phase in this project's tasks yet.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Refresh scores" }));
		expect(api.scoreProjectAgentHealth).toHaveBeenCalledTimes(2);
	});

	it("lists the agents without enough phases, with the minimum", async () => {
		api.scoreProjectAgentHealth.mockResolvedValue({
			success: true,
			tasks_read: 2,
			min_runs: 5,
			scores: [],
			pending: [{ agent_name: "planner:x:y", role: "planner", provider: "", model: "opus", runs: 2 }],
		});
		render(<AgentHealthPanel projectPath="/work/shop" />);
		expect(await screen.findByText("Not enough phases for a score yet (5 needed):")).toBeInTheDocument();
		expect(screen.getByText("Planner")).toBeInTheDocument();
		expect(screen.getByText("opus")).toBeInTheDocument();
		expect(screen.getByText("2 phases")).toBeInTheDocument();
		expect(screen.queryByText("No finished phase in this project's tasks yet.")).not.toBeInTheDocument();
	});

	it("shows no other project's scores", async () => {
		api.scoreProjectAgentHealth.mockResolvedValue({
			success: true,
			tasks_read: 1,
			min_runs: 3,
			scores: [SCORE],
			pending: [],
		});
		const { rerender } = render(<AgentHealthPanel projectPath="/work/shop" />);
		await screen.findByText("Coder");
		api.scoreProjectAgentHealth.mockReturnValue(new Promise(() => undefined));
		rerender(<AgentHealthPanel projectPath="/work/api" />);
		expect(screen.queryByText("Coder")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Refresh scores" })).toBeDisabled();
	});
});
