/**
 * The preload's bisect methods (#375): one channel constant each, the
 * arguments passed as given (the main process checks them), and a listener
 * that can be removed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants/ipc";

const ipc = vi.hoisted(() => ({
	invoke: vi.fn(),
	on: vi.fn(),
	removeListener: vi.fn(),
}));
vi.mock("electron", () => ({ ipcRenderer: ipc }));

import { createSelfHealingAPI } from "../self-healing-api";

beforeEach(() => {
	ipc.invoke.mockReset();
	ipc.on.mockReset();
	ipc.removeListener.mockReset();
});

describe("self-healing preload API", () => {
	it("asks the main process for a bisect", async () => {
		ipc.invoke.mockResolvedValue({ success: true });
		const api = createSelfHealingAPI();
		expect(await api.bisectIncident("/proj", "inc1", "abc1234")).toEqual({ success: true });
		expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SELF_HEALING_BISECT, "/proj", "inc1", "abc1234");
	});

	it("forwards each progress event and removes its own listener", () => {
		const callback = vi.fn();
		const stop = createSelfHealingAPI().onBisectProgress(callback);
		const [channel, handler] = ipc.on.mock.calls[0];
		expect(channel).toBe(IPC_CHANNELS.SELF_HEALING_BISECT_PROGRESS);
		handler({}, { incidentId: "inc1" });
		expect(callback).toHaveBeenCalledWith({ incidentId: "inc1" });
		stop();
		expect(ipc.removeListener).toHaveBeenCalledWith(IPC_CHANNELS.SELF_HEALING_BISECT_PROGRESS, handler);
	});
});
