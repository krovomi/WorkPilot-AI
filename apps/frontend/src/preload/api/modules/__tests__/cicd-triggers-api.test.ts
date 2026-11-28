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

	it("forwards the links, the figures and a review on their channels (#366, lot 4)", async () => {
		const api = createCicdTriggersAPI();
		await api.getDeployLinks("/p");
		await api.setDeployLinks("/p", ["web"]);
		await api.getDeployFigures("/p");
		await api.reviewDeployVerdict("/p", "42", "false_positive");
		expect(invokeIpc).toHaveBeenCalledWith(IPC_CHANNELS.CICD_TRIGGERS_GET_LINKS, "/p");
		expect(invokeIpc).toHaveBeenCalledWith(IPC_CHANNELS.CICD_TRIGGERS_SET_LINKS, "/p", ["web"]);
		expect(invokeIpc).toHaveBeenCalledWith(IPC_CHANNELS.CICD_TRIGGERS_GET_FIGURES, "/p");
		expect(invokeIpc).toHaveBeenCalledWith(IPC_CHANNELS.CICD_TRIGGERS_REVIEW_VERDICT, "/p", "42", "false_positive");
	});
});
