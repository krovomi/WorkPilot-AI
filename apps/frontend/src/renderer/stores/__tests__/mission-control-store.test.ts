/** @vitest-environment jsdom */
/**
 * The Mission Control store's part in live rebalancing (#344): a crew's plan
 * goes to the session, a composed agent says where it came from, and the
 * history of past sessions is read, again once a session ends.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMissionControlStore } from "../mission-control-store";

let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
	useMissionControlStore.setState(useMissionControlStore.getInitialState());
	api = {
		missionControlSetPlan: vi.fn().mockResolvedValue({ success: true, data: {} }),
		missionControlGetMetrics: vi.fn().mockResolvedValue({ success: true, data: { sessions: 2 } }),
		missionControlGetState: vi.fn().mockResolvedValue({ success: false, error: "" }),
		missionControlStopSession: vi.fn().mockResolvedValue({ success: true }),
		missionControlCreateAgent: vi.fn().mockResolvedValue({ success: true, data: { id: "a1" } }),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
});

describe("mission control store", () => {
	it("sets the plan, then refreshes the state", async () => {
		expect(await useMissionControlStore.getState().setPlan({ autoRebalance: false })).toBe(true);
		expect(api.missionControlSetPlan).toHaveBeenCalledWith({ autoRebalance: false });
		expect(api.missionControlGetState).toHaveBeenCalled();
	});

	it("keeps a refused plan's reason", async () => {
		api.missionControlSetPlan.mockResolvedValue({ success: false, error: "invalid_plan" });
		expect(await useMissionControlStore.getState().setPlan({ providers: [] })).toBe(false);
		expect(useMissionControlStore.getState().error).toBe("invalid_plan");
		api.missionControlSetPlan.mockResolvedValue({ success: false });
		await useMissionControlStore.getState().setPlan({ providers: [] });
		expect(useMissionControlStore.getState().error).toBeNull();
	});

	it("reads the metrics, and keeps the last ones when the backend fails", async () => {
		await useMissionControlStore.getState().fetchMetrics();
		expect(useMissionControlStore.getState().metrics).toEqual({ sessions: 2 });
		api.missionControlGetMetrics.mockResolvedValue({ success: false, error: "down" });
		await useMissionControlStore.getState().fetchMetrics();
		expect(useMissionControlStore.getState().metrics).toEqual({ sessions: 2 });
	});

	it("reads the metrics again once a session ends", async () => {
		await useMissionControlStore.getState().stopSession();
		expect(api.missionControlGetMetrics).toHaveBeenCalledTimes(1);
	});

	it("sends a composed agent's origin and estimate", async () => {
		await useMissionControlStore
			.getState()
			.createAgent("Coder 1", "coder", "anthropic", "m", "M", { origin: "auto", estimatedTokens: 900 });
		expect(api.missionControlCreateAgent).toHaveBeenCalledWith({
			name: "Coder 1",
			role: "coder",
			provider: "anthropic",
			model: "m",
			modelLabel: "M",
			origin: "auto",
			estimatedTokens: 900,
		});
	});
});
