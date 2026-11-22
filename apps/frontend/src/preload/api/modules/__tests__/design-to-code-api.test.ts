/** The loop's figures are asked for on their own channel, by project id. */
import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => ({ loops: 0 })));
vi.mock("electron", () => ({ ipcRenderer: { invoke } }));

import { IPC_CHANNELS } from "../../../../shared/constants/ipc";
import { createDesignToCodeAPI } from "../design-to-code-api";

describe("createDesignToCodeAPI", () => {
	it("invokes designToCode:loopStats with the project id", async () => {
		await createDesignToCodeAPI().getDesignLoopStats("p1");
		expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.DESIGN_TO_CODE_LOOP_STATS, "p1");
	});
});
