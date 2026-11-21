/**
 * Mission Control from the person's side: launch a session, add agents, start
 * and stop them, follow their reasoning and events, close the session. The
 * backend is a small fake behind `window.electronAPI`.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { MissionControlState } from "../../../shared/types/mission-control";
import { useMissionControlStore } from "../../stores/mission-control-store";
import { useProjectStore } from "../../stores/project-store";
import type { AgentSlot } from "../../stores/mission-control-store";
import { MissionControlDashboard } from "./MissionControlDashboard";

// Its own test: WavesView.test.tsx. It adds buttons these tests do not click.
vi.mock("../conflict-predictor/WavesView", () => ({ WavesView: () => null }));

const session = {
	session_id: "test-session",
	is_active: true,
	created_at: 0,
	agent_count: 0,
	running_count: 0,
	total_tokens: 0,
	total_cost_usd: 0,
	elapsed_seconds: 65,
};

function agent(overrides: Partial<AgentSlot>): AgentSlot {
	return {
		id: "a1",
		name: "Agent Coder",
		role: "coder",
		status: "idle",
		provider: "anthropic",
		model: "m",
		model_label: "Sonnet",
		current_task: "",
		current_step: "",
		progress: 0,
		tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 1000, estimated_cost_usd: 0.01 },
		active_files: [],
		current_thinking: "",
		last_tool_call: "",
		last_tool_input: "",
		decision_path: [],
		started_at: null,
		completed_at: null,
		elapsed_seconds: 0,
		streaming_session_id: null,
		output: "",
		error_message: "",
		...overrides,
	};
}

let backend: MissionControlState;
let api: Record<string, ReturnType<typeof vi.fn>>;

const ok = <T,>(data?: T) => ({ success: true, data });

beforeAll(() => {
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
	Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(async () => {
	await i18n.changeLanguage("en");
	useMissionControlStore.setState(useMissionControlStore.getInitialState());
	useProjectStore.setState({ selectedProjectId: "p1" });
	backend = { session, agents: [], decision_trees: {}, recent_events: [] };
	api = {
		missionControlStartSession: vi.fn().mockResolvedValue(ok(session)),
		missionControlStopSession: vi.fn().mockResolvedValue(ok()),
		missionControlGetState: vi
			.fn()
			// The page asks first whether a session is already open: none is.
			.mockResolvedValueOnce({ success: false, error: "" })
			.mockImplementation(async () => ok(structuredClone(backend))),
		missionControlCreateAgent: vi.fn(async (req: { name: string; role: string }) => {
			const created = agent({ id: "new1", name: req.name, role: req.role });
			backend.agents.push(created);
			return ok(created);
		}),
		missionControlRemoveAgent: vi.fn(async (id: string) => {
			backend.agents = backend.agents.filter((a) => a.id !== id);
			return ok();
		}),
		missionControlStartAgent: vi.fn().mockResolvedValue(ok()),
		missionControlStopAgent: vi.fn().mockResolvedValue(ok()),
		missionControlSetPlan: vi.fn().mockResolvedValue(ok()),
		// No session ran before: the history stays hidden.
		missionControlGetMetrics: vi.fn().mockResolvedValue(ok({ sessions: 0 })),
		// The model catalog of the add dialog: the backend's answer is not needed.
		localBackendRequest: vi.fn().mockResolvedValue({ unreachable: true }),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
});
afterEach(() => {
	cleanup();
	useMissionControlStore.getState().stopPolling();
});

async function openSession(state: Partial<MissionControlState> = {}) {
	backend = { ...backend, ...state };
	api.missionControlGetState.mockReset().mockImplementation(async () => ok(structuredClone(backend)));
	render(<MissionControlDashboard />);
	await screen.findByText("test-session");
}

describe("before a session", () => {
	it("explains what it does and launches through the main process", async () => {
		render(<MissionControlDashboard />);
		expect(screen.getByText("Several agents on one goal")).toBeInTheDocument();
		expect(screen.getByText("Run several agents side by side, each with its own task.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Launch Mission Control" }));
		await screen.findByText("test-session");
		expect(api.missionControlStartSession).toHaveBeenCalled();
		expect(screen.getByText("No agents yet. Add your first agent to get started.")).toBeInTheDocument();
	});

	it("shows launch failures and permits retry", async () => {
		api.missionControlStartSession.mockResolvedValue({ success: false, error: "Backend unavailable" });
		render(<MissionControlDashboard />);
		fireEvent.click(screen.getByRole("button", { name: "Launch Mission Control" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Unable to launch Mission Control: Backend unavailable");
		await waitFor(() => expect(screen.getByRole("button", { name: "Launch Mission Control" })).toBeEnabled());
		expect(useMissionControlStore.getState().isActive).toBe(false);
	});

	it("reopens a session the backend still holds", async () => {
		await openSession();
		expect(api.missionControlStartSession).not.toHaveBeenCalled();
	});

	it("offers a new launch when the backend's session has ended", async () => {
		api.missionControlGetState
			.mockReset()
			.mockResolvedValue(ok({ ...backend, session: { ...session, is_active: false } }));
		render(<MissionControlDashboard />);
		await waitFor(() => expect(api.missionControlGetState).toHaveBeenCalled());
		expect(await screen.findByRole("button", { name: "Launch Mission Control" })).toBeInTheDocument();
		expect(screen.queryByText("test-session")).toBeNull();
	});
});

describe("during a session", () => {
	const coder = agent({ id: "a1", name: "Agent Coder", status: "running" });
	const tester = agent({
		id: "a2",
		name: "Agent Tester",
		role: "tester",
		tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 500, estimated_cost_usd: 0.02 },
	});
	const tree = {
		agent_id: "a1",
		root_id: "r",
		current_node_id: "r",
		node_count: 1,
		nodes: {
			r: {
				id: "r",
				parent_id: null,
				node_type: "root" as const,
				status: "active" as const,
				label: "Task: fix the login",
				description: "",
				timestamp: 0,
				tool_name: "",
				tool_input: "",
				tool_output: "",
				options_considered: [],
				chosen_option: "",
				reasoning: "",
				children: [],
				duration_ms: 0,
			},
		},
	};

	it("sums the crew's work, in the app's language", async () => {
		await openSession({ agents: [coder, tester] });
		expect(screen.getByText("1/2")).toBeInTheDocument();
		expect(screen.getByText("1,500")).toBeInTheDocument();
		expect(screen.getByText("$0.0300")).toBeInTheDocument();
		expect(screen.getByText("1m 5s")).toBeInTheDocument();
		cleanup();

		await i18n.changeLanguage("fr");
		render(<MissionControlDashboard />);
		expect(await screen.findByText(/^1\s500$/)).toBeInTheDocument();
		expect(screen.getByText("0.0300 $")).toBeInTheDocument();
	});

	it("shows an agent's decision tree once it is selected, and the event log", async () => {
		const user = userEvent.setup();
		await openSession({
			agents: [coder, tester],
			decision_trees: { a1: tree },
			recent_events: [{ type: "agent_started", timestamp: 1, data: { agent_id: "a1", task: "Fix the login" } }],
		});
		expect(screen.getByText("Select an agent to view its decision tree")).toBeInTheDocument();
		expect(screen.getByText("Agent started")).toBeInTheDocument();
		expect(screen.getByText("Fix the login")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Agent Coder" }));
		expect(screen.getByRole("button", { name: "Agent Coder" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByText("Task: fix the login")).toBeInTheDocument();

		// An agent without a tree yet.
		await user.click(screen.getByRole("button", { name: "Agent Tester" }));
		expect(screen.getByText("Select an agent to view its decision tree")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Actions for Agent Coder" }));
		await user.click(screen.getByRole("menuitem", { name: "Decision Tree" }));
		expect(screen.getByText("Task: fix the login")).toBeInTheDocument();
	});

	it("starts, stops and removes agents through the main process", async () => {
		const user = userEvent.setup();
		await openSession({ agents: [coder, tester] });

		await user.type(screen.getByRole("textbox", { name: "Task for Agent Tester" }), "Write the tests{Enter}");
		expect(api.missionControlStartAgent).toHaveBeenCalledWith({
			agentId: "a2",
			task: "Write the tests",
			projectId: "p1",
		});

		await user.click(screen.getByRole("button", { name: "Stop Agent Coder" }));
		expect(api.missionControlStopAgent).toHaveBeenCalledWith("a1");

		await user.click(screen.getByRole("button", { name: "Actions for Agent Tester" }));
		await user.click(screen.getByRole("menuitem", { name: "Remove" }));
		await waitFor(() => expect(screen.queryByText("Agent Tester")).toBeNull());
		expect(api.missionControlRemoveAgent).toHaveBeenCalledWith("a2");
	});

	it("shows why an agent did not start", async () => {
		const user = userEvent.setup();
		api.missionControlStartAgent.mockResolvedValue({ success: false, error: "A task is required" });
		await openSession({ agents: [agent({ id: "a1", status: "completed" })] });
		await user.click(screen.getByRole("button", { name: "Restart" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("A task is required");
		expect(api.missionControlStartAgent).toHaveBeenCalledWith({ agentId: "a1", task: "", projectId: "p1" });
	});

	it("adds an agent and closes the dialog once it exists", async () => {
		const user = userEvent.setup();
		await openSession();
		await user.click(screen.getByRole("button", { name: "Add Agent" }));
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("button", { name: "Create Agent" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(api.missionControlCreateAgent).toHaveBeenCalledWith(
			expect.objectContaining({ name: "Agent Coder", role: "coder", provider: "anthropic" }),
		);
		expect(await screen.findByRole("button", { name: "Agent Coder" })).toBeInTheDocument();
	});

	it("keeps the dialog open and says why an agent was not created", async () => {
		const user = userEvent.setup();
		api.missionControlCreateAgent
			.mockResolvedValueOnce({ success: false, error: "Quota exceeded" })
			.mockResolvedValueOnce({ success: false });
		await openSession();
		await user.click(screen.getByRole("button", { name: "Add Agent" }));
		const dialog = await screen.findByRole("dialog");
		await user.click(within(dialog).getByRole("button", { name: "Create Agent" }));
		expect(await within(dialog).findByRole("alert")).toHaveTextContent(
			"Unable to create the agent: Quota exceeded",
		);
		await user.click(within(dialog).getByRole("button", { name: "Create Agent" }));
		await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("The agent was not created."));

		// Opened again, the dialog starts without the old refusal.
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await user.click(screen.getByRole("button", { name: "Add Agent" }));
		expect(within(await screen.findByRole("dialog")).queryByRole("alert")).toBeNull();
	});

	it("refreshes on demand and closes the session", async () => {
		const user = userEvent.setup();
		await openSession();
		const reads = api.missionControlGetState.mock.calls.length;
		await user.click(screen.getByRole("button", { name: "Refresh" }));
		expect(api.missionControlGetState.mock.calls.length).toBeGreaterThan(reads);

		await user.click(screen.getByRole("button", { name: "Stop" }));
		expect(await screen.findByRole("button", { name: "Launch Mission Control" })).toBeInTheDocument();
		expect(api.missionControlStopSession).toHaveBeenCalled();
	});
});
