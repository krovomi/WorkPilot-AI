/**
 * The bridge forwards an auto-compose request on its own channel, as data.
 */
import { describe, expect, it, vi } from "vitest";

const invokeIpc = vi.fn(async () => ({ success: true }));
vi.mock("../ipc-utils", () => ({ invokeIpc: (...args: unknown[]) => invokeIpc(...(args as [])) }));

import { IPC_CHANNELS } from "../../../../shared/constants";
import { createMissionControlAPI } from "../mission-control-api";

describe("createMissionControlAPI", () => {
	it("invokes missionControl:suggestComposition with the request", async () => {
		const request = { providers: ["anthropic", "ollama"], prompt: "Fix the login" };
		await createMissionControlAPI().missionControlSuggestComposition(request);
		expect(invokeIpc).toHaveBeenCalledWith(
			IPC_CHANNELS.MISSION_CONTROL_SUGGEST_COMPOSITION,
			request,
		);
	});

	it("invokes the plan and metrics channels", async () => {
		const api = createMissionControlAPI();
		await api.missionControlSetPlan({ autoRebalance: false });
		expect(invokeIpc).toHaveBeenCalledWith(IPC_CHANNELS.MISSION_CONTROL_SET_PLAN, { autoRebalance: false });
		await api.missionControlGetMetrics();
		expect(invokeIpc).toHaveBeenCalledWith(IPC_CHANNELS.MISSION_CONTROL_GET_METRICS);
	});
});
