/**
 * The bridge forwards a plan request on its own channel, as data.
 */
import { describe, expect, it, vi } from "vitest";

const invokeIpc = vi.fn(async () => ({ success: true }));
vi.mock("../ipc-utils", () => ({ invokeIpc: (...args: unknown[]) => invokeIpc(...(args as [])) }));

import { IPC_CHANNELS } from "../../../../shared/constants";
import { createConflictWavesAPI } from "../conflict-waves-api";

describe("createConflictWavesAPI", () => {
	it("invokes conflictWaves:plan with the request", async () => {
		const request = { projectId: "p1", taskIds: ["001-a"] };
		await createConflictWavesAPI().planExecutionWaves(request);
		expect(invokeIpc).toHaveBeenCalledWith(IPC_CHANNELS.CONFLICT_WAVES_PLAN, request);
	});

	it("invokes the run channels with a project id or the state, as data", async () => {
		const api = createConflictWavesAPI();
		const state = { projectId: "p1", waves: [["001-a"]], current: 0, advanceWhen: "merged" as const, maxParallel: 2, started: [] };
		await api.loadExecutionWaveRun("p1");
		expect(invokeIpc).toHaveBeenCalledWith(IPC_CHANNELS.CONFLICT_WAVES_RUN_LOAD, "p1");
		await api.saveExecutionWaveRun(state);
		expect(invokeIpc).toHaveBeenCalledWith(IPC_CHANNELS.CONFLICT_WAVES_RUN_SAVE, state);
		await api.clearExecutionWaveRun("p1");
		expect(invokeIpc).toHaveBeenCalledWith(IPC_CHANNELS.CONFLICT_WAVES_RUN_CLEAR, "p1");
	});
});
