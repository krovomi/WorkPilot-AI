/**
 * The bridge forwards each sprint call on its own channel, ids and bodies as data.
 */
import { describe, expect, it, vi } from "vitest";

const invokeIpc = vi.fn(async () => ({ success: true }));
vi.mock("../ipc-utils", () => ({ invokeIpc: (...args: unknown[]) => invokeIpc(...(args as [])) }));

import { IPC_CHANNELS } from "../../../../shared/constants";
import { createSprintsAPI } from "../sprints-api";

describe("createSprintsAPI", () => {
	it("invokes the sprint channels with the project, the sprint and the body", async () => {
		const api = createSprintsAPI();
		const report = { done: 1, donePoints: 2, carried: 0, carriedPoints: 0, carriedTo: null };
		await api.listSprints("p1");
		expect(invokeIpc).toHaveBeenCalledWith(IPC_CHANNELS.SPRINTS_LIST, "p1");
		await api.saveSprint("p1", { name: "S" });
		expect(invokeIpc).toHaveBeenCalledWith(IPC_CHANNELS.SPRINTS_SAVE, "p1", { name: "S" });
		await api.startSprint("p1", "sp-0000000a", { cards: 1, points: 2 });
		expect(invokeIpc).toHaveBeenCalledWith(IPC_CHANNELS.SPRINTS_START, "p1", "sp-0000000a", { cards: 1, points: 2 });
		await api.completeSprint("p1", "sp-0000000a", report);
		expect(invokeIpc).toHaveBeenCalledWith(IPC_CHANNELS.SPRINTS_COMPLETE, "p1", "sp-0000000a", report);
		await api.deleteSprint("p1", "sp-0000000a");
		expect(invokeIpc).toHaveBeenCalledWith(IPC_CHANNELS.SPRINTS_DELETE, "p1", "sp-0000000a");
	});
});
