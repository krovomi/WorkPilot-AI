/** The spoken stop's preload method: one constant channel, no argument from the renderer. */
import { describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: { invoke, send: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));

import { IPC_CHANNELS } from "../../../shared/constants";
import { createTaskAPI } from "../task-api";

describe("stopAgentsAfterStep", () => {
	it("invokes AGENTS_STOP_AFTER_STEP with nothing else", async () => {
		invoke.mockResolvedValue({ success: true, data: { stoppingTasks: [], failedTasks: [] } });
		await createTaskAPI().stopAgentsAfterStep();
		expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.AGENTS_STOP_AFTER_STEP);
	});
});
