/**
 * Live rebalancing and its history, from the person's side (#344): the
 * session's budget and rebalancings with the switch that turns them off, the
 * card of an agent that was moved or looped, the event log's account of each
 * decision, and what past sessions measured.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { MissionControlMetrics as Metrics, MissionControlSession } from "../../../../shared/types/mission-control";
import type { AgentSlot, MCEvent } from "../../../stores/mission-control-store";
import { useMissionControlStore } from "../../../stores/mission-control-store";
import { AgentEventLog } from "../AgentEventLog";
import { AgentPanel } from "../AgentPanel";
import { MissionControlMetrics } from "../MissionControlMetrics";
import { SessionHealth } from "../SessionHealth";

const session: MissionControlSession = {
	session_id: "s1",
	is_active: true,
	created_at: 0,
	agent_count: 1,
	running_count: 0,
	total_tokens: 0,
	total_cost_usd: 0,
	elapsed_seconds: 0,
};

beforeEach(async () => {
	await i18n.changeLanguage("en");
	useMissionControlStore.setState(useMissionControlStore.getInitialState());
});
afterEach(cleanup);

describe("SessionHealth", () => {
	it("shows the budgets, the rebalancings and the overrun", () => {
		render(
			<SessionHealth
				session={{
					...session,
					over_budget: true,
					rebalance_count: 2,
					plan: { providers: ["anthropic"], budget_usd: 0.5, budget_tokens: 9000, auto_rebalance: true },
				}}
				tokens={12000}
				cost={0.75}
			/>,
		);
		expect(screen.getByText("Spent $0.7500 of $0.5000")).toBeInTheDocument();
		expect(screen.getByText("Spent 12,000 of 9,000 tokens")).toBeInTheDocument();
		expect(screen.getByText("2 rebalancings")).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent("used up its budget");
	});

	it("shows a budget still within reach without a warning", () => {
		render(
			<SessionHealth
				session={{
					...session,
					over_budget: false,
					plan: { providers: ["anthropic"], budget_usd: 2, budget_tokens: 50000, auto_rebalance: true },
				}}
				tokens={100}
				cost={0.1}
			/>,
		);
		expect(screen.getByText("Spent $0.1000 of $2.0000")).toBeInTheDocument();
		expect(screen.getByText("Spent 100 of 50,000 tokens")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("without a plan, rebalancing is on and the switch turns it off", async () => {
		const setPlan = vi.fn().mockResolvedValue(true);
		useMissionControlStore.setState({ setPlan });
		render(<SessionHealth session={session} tokens={0} cost={0} />);
		expect(screen.getByText("0 rebalancings")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
		const toggle = screen.getByRole("checkbox", { name: "Rebalance stuck agents automatically" });
		expect(toggle).toBeChecked();
		fireEvent.click(toggle);
		await waitFor(() => expect(setPlan).toHaveBeenCalledWith({ autoRebalance: false }));
	});

	it("turns it back on", async () => {
		const setPlan = vi.fn().mockResolvedValue(true);
		useMissionControlStore.setState({ setPlan });
		render(
			<SessionHealth
				session={{
					...session,
					rebalance_count: 1,
					plan: { providers: [], budget_usd: null, budget_tokens: null, auto_rebalance: false },
				}}
				tokens={0}
				cost={0}
			/>,
		);
		expect(screen.getByText("1 rebalancing")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("checkbox"));
		await waitFor(() => expect(setPlan).toHaveBeenCalledWith({ autoRebalance: true }));
	});
});

const agent = (overrides: Partial<AgentSlot>): AgentSlot =>
	({
		id: "a1",
		name: "Agent Coder",
		role: "coder",
		status: "running",
		provider: "anthropic",
		model: "m",
		model_label: "Sonnet",
		current_task: "",
		tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost_usd: 0 },
		active_files: [],
		output: "",
		error_message: "",
		...overrides,
	}) as AgentSlot;

describe("AgentPanel", () => {
	const handlers = {
		onSelect: vi.fn(),
		onStart: vi.fn(),
		onStop: vi.fn(),
		onRemove: vi.fn(),
		onShowDecisionTree: vi.fn(),
	};

	it("says the agent was rebalanced and that its answer looped", () => {
		render(<AgentPanel agent={agent({ rebalances: 2, loop_detected: true })} isSelected={false} {...handlers} />);
		expect(screen.getByText("Rebalanced 2 times")).toBeInTheDocument();
		expect(screen.getByText("Answer looped")).toBeInTheDocument();
	});

	it("shows only what happened", () => {
		const { rerender } = render(
			<AgentPanel agent={agent({ loop_detected: true })} isSelected={false} {...handlers} />,
		);
		expect(screen.queryByText(/Rebalanced/)).toBeNull();
		rerender(<AgentPanel agent={agent({ rebalances: 1 })} isSelected={false} {...handlers} />);
		expect(screen.getByText("Rebalanced once")).toBeInTheDocument();
		expect(screen.queryByText("Answer looped")).toBeNull();
		rerender(<AgentPanel agent={agent({ rebalances: 0 })} isSelected={false} {...handlers} />);
		expect(screen.queryByTestId("mission-control-agent-rebalanced")).toBeNull();
	});
});

describe("AgentEventLog", () => {
	it("tells each rebalancing decision in words", () => {
		const events: MCEvent[] = [
			{
				type: "agent_rebalanced",
				timestamp: 1,
				data: { agent_id: "a1", reason: "loop", action: "escalate", from: "Haiku", to: "Sonnet" },
			},
			{
				type: "agent_rebalance_skipped",
				timestamp: 2,
				data: { agent_id: "a1", reason: "rate_limited", skipped: "over_budget" },
			},
			{ type: "agent_loop_detected", timestamp: 3, data: { agent_id: "a1" } },
			// Odd records say nothing more than their title.
			{ type: "agent_rebalanced", timestamp: 4, data: { agent_id: "a1", reason: "failed" } },
			{ type: "agent_failed", timestamp: 5, data: { agent_id: "a1", reason: "failed" } },
		];
		render(<AgentEventLog events={events} agents={[agent({})]} />);
		expect(
			screen.getByText("The answer kept repeating itself: moved to a bigger model, Haiku → Sonnet"),
		).toBeInTheDocument();
		expect(
			screen.getByText("Provider rate limit or quota: the session is over its budget"),
		).toBeInTheDocument();
		expect(screen.getByText("Answer is looping")).toBeInTheDocument();
		expect(screen.getAllByText("Agent rebalanced")).toHaveLength(2);
		expect(screen.queryByText(/^The run failed/)).toBeNull();
	});
});

const METRICS: Metrics = {
	sessions: 4,
	auto_share: 0.5,
	avg_tokens_auto: 1000,
	avg_tokens_manual: 1500,
	delta_tokens: -500,
	estimate_ratio: 1.2,
	rebalances_per_session: 0.75,
	budget_sessions: 2,
	overrun_rate: 0.5,
};

describe("MissionControlMetrics", () => {
	const withMetrics = (metrics: Metrics | null) => {
		const fetchMetrics = vi.fn(async () => {
			useMissionControlStore.setState({ metrics });
		});
		useMissionControlStore.setState({ fetchMetrics });
		return fetchMetrics;
	};

	it("shows the four measures of past sessions", async () => {
		const fetchMetrics = withMetrics(METRICS);
		render(<MissionControlMetrics />);
		expect(await screen.findByTestId("mission-control-metrics")).toBeInTheDocument();
		expect(fetchMetrics).toHaveBeenCalled();
		expect(screen.getByText("4 sessions")).toBeInTheDocument();
		expect(screen.getAllByText("50%")).toHaveLength(2);
		expect(screen.getByText("1,000 / 1,500 (Δ -500)")).toBeInTheDocument();
		expect(screen.getByText("× 1.20")).toBeInTheDocument();
		expect(screen.getByText("0.75")).toBeInTheDocument();
	});

	it("marks a measure it has no data for", async () => {
		withMetrics({
			...METRICS,
			sessions: 1,
			avg_tokens_manual: null,
			delta_tokens: null,
			estimate_ratio: null,
			rebalances_per_session: null,
			overrun_rate: null,
			auto_share: null,
			avg_tokens_auto: null,
		});
		render(<MissionControlMetrics />);
		expect(await screen.findByText("1 session")).toBeInTheDocument();
		expect(screen.getByText("— / — (—)")).toBeInTheDocument();
		expect(screen.getAllByText("—")).toHaveLength(4);
	});

	it("signs a positive difference", async () => {
		withMetrics({ ...METRICS, delta_tokens: 250, avg_tokens_auto: 1750 });
		render(<MissionControlMetrics />);
		expect(await screen.findByText("1,750 / 1,500 (Δ +250)")).toBeInTheDocument();
	});

	it("stays hidden before any session", async () => {
		const fetchMetrics = withMetrics({ ...METRICS, sessions: 0 });
		const { container } = render(<MissionControlMetrics />);
		await waitFor(() => expect(fetchMetrics).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});
});
