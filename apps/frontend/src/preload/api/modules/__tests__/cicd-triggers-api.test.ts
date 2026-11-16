/**
 * The bridge forwards a rollback on its own channel, as data (#366).
 */
import { describe, expect, it, vi } from "vitest";

const invokeIpc = vi.fn(async () => ({ success: true }));
vi.mock("../ipc-utils", () => ({ invokeIpc: (...args: unknown[]) => invokeIpc(...(args as [])) }));

import { IPC_CHANNELS } from "../../../../shared/constants";
import { createCicdTriggersAPI } from "../cicd-triggers-api";

describe("createCicdTriggersAPI", () => {
	it("invokes cicdTriggers:rollback with the project and the run", async () => {
		await createCicdTriggersAPI().rollbackDeployment("/projects/shop", "42");
		expect(invokeIpc).toHaveBeenCalledWith(IPC_CHANNELS.CICD_TRIGGERS_ROLLBACK, "/projects/shop", "42");
	});
});
