/**
 * The Replay view asks main for the recorded sessions (`replay-handlers.ts`)
 * and says the backend did not answer only when nothing answered.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentReplayStore } from "../agent-replay-store";

vi.mock("i18next", () => ({
	default: { t: (key: string) => key },
}));

const api = {
	listReplaySessions: vi.fn(),
	getReplaySession: vi.fn(),
	addReplayBreakpoint: vi.fn(),
};

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	vi.stubGlobal("window", { electronAPI: api });
	useAgentReplayStore.setState({ sessions: [], error: null, breakpoints: [] });
});

describe("agent replay store", () => {
	it("lists the sessions main read from the backend", async () => {
		api.listReplaySessions.mockResolvedValue({
			success: true,
			sessions: [{ session_id: "a1" }],
		});

		await useAgentReplayStore.getState().fetchSessions();

		expect(useAgentReplayStore.getState().sessions).toEqual([{ session_id: "a1" }]);
		expect(useAgentReplayStore.getState().error).toBeNull();
	});

	it("says the backend did not answer when nothing listens", async () => {
		api.listReplaySessions.mockResolvedValue({
			success: false,
			error: "fetch failed",
			unreachable: true,
		});

		await useAgentReplayStore.getState().fetchSessions();

		expect(useAgentReplayStore.getState().error).toBe("replay:errors.backendUnreachable");
	});

	it("shows the backend's own error otherwise", async () => {
		api.getReplaySession.mockResolvedValue({
			success: false,
			error: "Replay session not found",
		});

		await useAgentReplayStore.getState().loadSession("gone");

		expect(useAgentReplayStore.getState().error).toBe("Replay session not found");
	});

	it("adds the breakpoint the backend created", async () => {
		api.addReplayBreakpoint.mockResolvedValue({
			success: true,
			breakpoint: { id: "bp1" },
		});

		await useAgentReplayStore.getState().addBreakpoint("a1", "tool_call", "Bash");

		expect(api.addReplayBreakpoint).toHaveBeenCalledWith("a1", {
			breakpoint_type: "tool_call",
			condition: "Bash",
			description: "",
		});
		expect(useAgentReplayStore.getState().breakpoints).toEqual([{ id: "bp1" }]);
	});
});
