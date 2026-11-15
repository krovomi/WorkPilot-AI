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
});
