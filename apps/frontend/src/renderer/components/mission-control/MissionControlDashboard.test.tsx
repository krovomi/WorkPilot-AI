import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMissionControlStore } from "../../stores/mission-control-store";
import { MissionControlDashboard } from "./MissionControlDashboard";

vi.mock("./index", () => ({
  AddAgentDialog: () => null,
  AgentEventLog: () => null,
  AgentPanel: () => null,
  DecisionTreeViewer: () => null,
}));

beforeEach(() => {
  vi.stubEnv("VITE_BACKEND_URL", "");
  useMissionControlStore.setState(useMissionControlStore.getInitialState());
});
afterEach(() => {
  cleanup();
  useMissionControlStore.getState().stopPolling();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("launches through the local backend and opens the dashboard", async () => {
  const session = { session_id: "test-session", is_active: true };
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, session, state: { session, agents: [], decision_trees: {}, recent_events: [] } }) });
  vi.stubGlobal("fetch", fetchMock);
  render(<MissionControlDashboard />);
  fireEvent.click(screen.getByRole("button"));
  await screen.findByText("test-session");
  expect(fetchMock).toHaveBeenCalledWith("http://localhost:9000/api/mission-control/session/start", expect.objectContaining({ method: "POST" }));
});

it("shows launch failures and permits retry", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Backend unavailable")));
  render(<MissionControlDashboard />);
  fireEvent.click(screen.getByRole("button"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Backend unavailable");
  await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
  expect(useMissionControlStore.getState().isActive).toBe(false);
});

it("honors an explicit backend URL", async () => {
  vi.stubEnv("VITE_BACKEND_URL", "http://localhost:9000/");
  const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
  vi.stubGlobal("fetch", fetchMock);
  await useMissionControlStore.getState().startSession();
  expect(fetchMock).toHaveBeenCalledWith("http://localhost:9000/api/mission-control/session/start", expect.anything());
});


