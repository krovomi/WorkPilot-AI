/**
 * The session plan and metrics channels (#344): the plan is checked before it
 * reaches the backend, a composed agent's origin too, and the backend's
 * answers come back as IPC results.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
	},
}));
vi.mock("../../project-store", () => ({ projectStore: { getProject: () => undefined } }));
vi.mock("../../oneshot-llm", () => ({ runOneShotLLM: vi.fn() }));
const backendFetch = vi.fn();
vi.mock("../_backend-fetch", () => ({ backendFetch: (...args: unknown[]) => backendFetch(...args) }));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { registerMissionControlHandlers } from "../mission-control-handlers";

const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
const sent = () => {
	const [path, init] = backendFetch.mock.calls.at(-1) as [string, RequestInit | undefined];
	return { path, body: init?.body ? JSON.parse(String(init.body)) : undefined };
};

beforeEach(() => {
	backendFetch.mockReset();
	registerMissionControlHandlers();
});

describe("MISSION_CONTROL_SET_PLAN", () => {
	it("sends a checked plan and returns the backend's", async () => {
		const plan = { providers: ["anthropic"], budget_usd: 1, budget_tokens: null, auto_rebalance: true };
		backendFetch.mockResolvedValue({ success: true, plan });
		const res = await invoke(IPC_CHANNELS.MISSION_CONTROL_SET_PLAN, { providers: ["anthropic"], budgetUsd: 1 });
		expect(res).toEqual({ success: true, data: plan });
		expect(sent()).toEqual({
			path: "/api/mission-control/session/plan",
			body: { providers: ["anthropic"], budget_usd: 1, budget_tokens: null },
		});
	});

	it("refuses a hostile plan without asking the backend", async () => {
		const res = await invoke(IPC_CHANNELS.MISSION_CONTROL_SET_PLAN, { providers: ["a; rm -rf"] });
		expect(res).toEqual({ success: false, error: "invalid_plan" });
		expect(backendFetch).not.toHaveBeenCalled();
	});

	it("passes the backend's refusal on", async () => {
		backendFetch.mockResolvedValue({ success: false, error: "Backend unavailable" });
		const res = await invoke(IPC_CHANNELS.MISSION_CONTROL_SET_PLAN, { autoRebalance: false });
		expect(res).toEqual({ success: false, error: "Backend unavailable" });
	});
});

describe("MISSION_CONTROL_GET_METRICS", () => {
	it("returns the backend's measures, or its refusal", async () => {
		backendFetch.mockResolvedValueOnce({ success: true, metrics: { sessions: 3 } });
		expect(await invoke(IPC_CHANNELS.MISSION_CONTROL_GET_METRICS)).toEqual({
			success: true,
			data: { sessions: 3 },
		});
		expect(sent().path).toBe("/api/mission-control/metrics");
		backendFetch.mockResolvedValueOnce({ success: false, error: "down" });
		expect(await invoke(IPC_CHANNELS.MISSION_CONTROL_GET_METRICS)).toEqual({ success: false, error: "down" });
	});
});

describe("MISSION_CONTROL_CREATE_AGENT", () => {
	const base = { name: "Coder 1", role: "coder", provider: "anthropic", model: "m", modelLabel: "M" };

	it("sends a composed agent's origin and estimate", async () => {
		backendFetch.mockResolvedValue({ success: true, agent: { id: "a1" } });
		await invoke(IPC_CHANNELS.MISSION_CONTROL_CREATE_AGENT, { ...base, origin: "auto", estimatedTokens: 900 });
		expect(sent().body).toEqual({
			name: "Coder 1",
			role: "coder",
			provider: "anthropic",
			model: "m",
			model_label: "M",
			origin: "auto",
			estimated_tokens: 900,
		});
	});

	it("refuses an origin it does not know", async () => {
		const res = await invoke(IPC_CHANNELS.MISSION_CONTROL_CREATE_AGENT, { ...base, origin: "server" });
		expect(res).toEqual({ success: false, error: "Invalid agent" });
		expect(backendFetch).not.toHaveBeenCalled();
	});
});
