/**
 * The agent debugger: sessions to attach to, the attached session's
 * breakpoints and paused frames, polled while attached, and the changes a
 * person sends it. A refusal is shown on the panel; a poll that comes back
 * after a detach changes nothing.
 *
 * @vitest-environment jsdom
 */
import i18n from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentDebuggerStore } from "../agent-debugger-store";

let api: Record<string, ReturnType<typeof vi.fn>>;
const INITIAL = useAgentDebuggerStore.getState();
const state = () => useAgentDebuggerStore.getState();
const debugState = { breakpoints: [{ id: "bp1" }], frames: [{ id: "f1" }] };

beforeEach(() => {
	useAgentDebuggerStore.setState(INITIAL, true);
	api = {
		listDebugSessions: vi.fn().mockResolvedValue({ sessions: [{ id: "s1" }] }),
		attachDebugger: vi.fn().mockResolvedValue({ ok: true }),
		detachDebugger: vi.fn().mockResolvedValue({ ok: true }),
		getDebugState: vi.fn().mockResolvedValue(debugState),
		setBreakpoint: vi.fn().mockResolvedValue({ ok: true }),
		removeBreakpoint: vi.fn().mockResolvedValue({ ok: true }),
		resumeFrame: vi.fn().mockResolvedValue({ ok: true }),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
});

describe("sessions", () => {
	it("lists them, and an answer without a list is an empty one", async () => {
		await state().listSessions();
		expect(state().sessions).toEqual([{ id: "s1" }]);
		api.listDebugSessions.mockResolvedValueOnce(null);
		await state().listSessions();
		expect(state().sessions).toEqual([]);
	});

	it("says why they could not be listed", async () => {
		api.listDebugSessions.mockRejectedValueOnce(new Error("runner missing"));
		await state().listSessions();
		expect(state().error).toBe("runner missing");
	});
});

describe("attaching", () => {
	it("attaches and reads the session's breakpoints and frames", async () => {
		await state().attach("s1");
		expect(api.attachDebugger).toHaveBeenCalledWith("s1");
		expect(state()).toMatchObject({ sessionId: "s1", loading: false, error: null, ...debugState });
	});

	it("says why it could not attach", async () => {
		api.attachDebugger.mockRejectedValueOnce(new Error("no such session"));
		await state().attach("s1");
		expect(state()).toMatchObject({ sessionId: null, loading: false, error: "no such session" });
	});

	it("detaches, forgets the session and lists the sessions again", async () => {
		await state().attach("s1");
		await state().detach();
		expect(api.detachDebugger).toHaveBeenCalledWith("s1");
		expect(state()).toMatchObject({ sessionId: null, breakpoints: [], frames: [], sessions: [{ id: "s1" }] });
	});

	it("stays attached when the detach is refused, and says why", async () => {
		await state().attach("s1");
		api.detachDebugger.mockRejectedValueOnce(new Error("busy"));
		await expect(state().detach()).resolves.toBeUndefined();
		expect(state()).toMatchObject({ sessionId: "s1", error: "busy", ...debugState });
	});

	it("does nothing while detached", async () => {
		await state().detach();
		await state().refresh();
		await state().addBreakpoint({ id: "x" } as never);
		await state().removeBreakpoint("x");
		await state().resume("f1", "continue");
		for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
	});
});

describe("polling the attached session", () => {
	beforeEach(() => state().attach("s1"));

	it("reads empty lists for an answer without them", async () => {
		api.getDebugState.mockResolvedValueOnce({});
		await state().refresh();
		expect(state()).toMatchObject({ breakpoints: [], frames: [] });
	});

	it("shows a failed poll without throwing", async () => {
		api.getDebugState.mockRejectedValueOnce(new Error("runner timed out"));
		await expect(state().refresh()).resolves.toBeUndefined();
		expect(state().error).toBe("runner timed out");
	});

	it("drops a poll, or its failure, that comes back after a detach", async () => {
		let answer: (value: unknown) => void = vi.fn();
		api.getDebugState.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		const polling = state().refresh();
		await state().detach();
		answer(debugState);
		await polling;
		expect(state()).toMatchObject({ sessionId: null, breakpoints: [], frames: [] });

		await state().attach("s1");
		let fail: (reason: unknown) => void = vi.fn();
		api.getDebugState.mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject)));
		const failing = state().refresh();
		await state().detach();
		fail(new Error("late"));
		await failing;
		expect(state().error).toBeNull();
	});
});

describe("changing the attached session", () => {
	beforeEach(() => state().attach("s1"));

	it("adds and removes a breakpoint and resumes a frame, reading the state again each time", async () => {
		api.getDebugState.mockClear();
		await state().addBreakpoint({ id: "bp2", type: "tool" } as never);
		await state().removeBreakpoint("bp1");
		await state().resume("f1", "modify", { toolInput: { path: "a" }, reason: "safer" });
		expect(api.setBreakpoint).toHaveBeenCalledWith("s1", { id: "bp2", type: "tool" });
		expect(api.removeBreakpoint).toHaveBeenCalledWith("s1", "bp1");
		expect(api.resumeFrame).toHaveBeenCalledWith("s1", "f1", "modify", { toolInput: { path: "a" }, reason: "safer" });
		expect(api.getDebugState).toHaveBeenCalledTimes(3);
	});

	it.each([
		["add a breakpoint", "setBreakpoint", () => state().addBreakpoint({ id: "x" } as never)],
		["remove a breakpoint", "removeBreakpoint", () => state().removeBreakpoint("x")],
		["resume a frame", "resumeFrame", () => state().resume("f1", "skip")],
	])("shows why it could not %s, without throwing", async (_name, method, action) => {
		api.getDebugState.mockClear();
		api[method].mockRejectedValueOnce(new Error("refused"));
		await expect(action()).resolves.toBeUndefined();
		expect(state().error).toBe("refused");
		expect(api.getDebugState).not.toHaveBeenCalled();
	});

	it.each([
		["add a breakpoint", "setBreakpoint", () => state().addBreakpoint({ id: "x" } as never)],
		["resume a frame", "resumeFrame", () => state().resume("f1", "skip")],
	])("shows that the runner refused to %s, and reads nothing again", async (_name, method, action) => {
		await i18n.changeLanguage("en");
		api.getDebugState.mockClear();
		api[method].mockResolvedValueOnce({ ok: false, reason: "unknown_frame" });
		await action();
		expect(state().error).toBe("The debugger refused this change: the paused call may have ended already.");
		expect(api.getDebugState).not.toHaveBeenCalled();
	});
});
