import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMissionControlStore } from "../../stores/mission-control-store";
import { MissionControlDashboard } from "./MissionControlDashboard";

vi.mock("./index", () => ({
	AddAgentDialog: () => null,
	AgentEventLog: () => null,
	AgentPanel: () => null,
	DecisionTreeViewer: () => null,
}));

const session = { session_id: "test-session", is_active: true };
let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
	useMissionControlStore.setState(useMissionControlStore.getInitialState());
	api = {
		missionControlStartSession: vi.fn().mockResolvedValue({ success: true, data: session }),
		missionControlGetState: vi
			.fn()
			// The page asks first whether a session is already open: none is.
			.mockResolvedValueOnce({ success: false, error: "" })
			.mockResolvedValue({
				success: true,
				data: { session, agents: [], decision_trees: {}, recent_events: [] },
			}),
		missionControlStartAgent: vi.fn().mockResolvedValue({ success: true }),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
});
afterEach(() => {
	cleanup();
	useMissionControlStore.getState().stopPolling();
});

it("launches through the main process and opens the dashboard", async () => {
	render(<MissionControlDashboard />);
	fireEvent.click(screen.getByRole("button"));
	await screen.findByText("test-session");
	expect(api.missionControlStartSession).toHaveBeenCalled();
});

it("shows launch failures and permits retry", async () => {
	api.missionControlStartSession.mockResolvedValue({ success: false, error: "Backend unavailable" });
	render(<MissionControlDashboard />);
	fireEvent.click(screen.getByRole("button"));
	expect(await screen.findByRole("alert")).toHaveTextContent("Backend unavailable");
	await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
	expect(useMissionControlStore.getState().isActive).toBe(false);
});

it("starts an agent in the selected project and shows its failure", async () => {
	api.missionControlStartAgent.mockResolvedValue({ success: false, error: "A task is required" });
	await useMissionControlStore.getState().startAgent("abc12345", "");
	expect(api.missionControlStartAgent).toHaveBeenCalledWith(
		expect.objectContaining({ agentId: "abc12345", task: "" }),
	);
	expect(useMissionControlStore.getState().error).toBe("A task is required");
});

it("reopens a session the backend still holds", async () => {
	api.missionControlGetState.mockReset().mockResolvedValue({
		success: true,
		data: { session, agents: [], decision_trees: {}, recent_events: [] },
	});
	render(<MissionControlDashboard />);
	await screen.findByText("test-session");
	expect(api.missionControlStartSession).not.toHaveBeenCalled();
});
