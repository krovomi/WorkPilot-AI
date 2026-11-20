/**
 * @vitest-environment jsdom
 *
 * What the main process says about one terminal reaches its entry in the
 * store, and only its own: exit (and removal two seconds later unless it came
 * back), title, worktree, Claude session, busy state, Claude leaving, and a
 * session waiting to be resumed. A deliberate recreation is not an exit.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalWorktreeConfig } from "../../../../shared/types";
import type { Terminal } from "../../../stores/terminal-store";
import { useTerminalStore } from "../../../stores/terminal-store";
import { useTerminalEvents } from "../useTerminalEvents";

const initialTerminals = useTerminalStore.getState();

type Listener = (id: string, ...args: never[]) => void;
const listeners = new Map<string, Listener>();
const unsubscribed: string[] = [];

const CHANNELS = [
	"onTerminalExit",
	"onTerminalTitleChange",
	"onTerminalWorktreeConfigChange",
	"onTerminalClaudeSession",
	"onTerminalClaudeBusy",
	"onTerminalClaudeExit",
	"onTerminalPendingResume",
] as const;

function emit(channel: (typeof CHANNELS)[number], ...args: unknown[]) {
	act(() => (listeners.get(channel) as (...a: unknown[]) => void)(...args));
}

const destroyTerminal = vi.fn();

function withTerminals(...overrides: Partial<Terminal>[]) {
	useTerminalStore.setState({
		terminals: overrides.map(
			(o, i) => ({ id: `term-${i + 1}`, title: `Shell ${i + 1}`, cwd: "/work", status: "running", ...o }) as Terminal,
		),
	});
}

const terminal = (id = "term-1") => useTerminalStore.getState().terminals.find((t) => t.id === id);

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	listeners.clear();
	unsubscribed.length = 0;
	const api: Record<string, unknown> = { destroyTerminal };
	for (const channel of CHANNELS) {
		api[channel] = (listener: Listener) => {
			listeners.set(channel, listener);
			return () => unsubscribed.push(channel);
		};
	}
	destroyTerminal.mockResolvedValue({ success: true });
	Object.assign(globalThis.electronAPI, api);
	withTerminals({}, {});
});

afterEach(() => {
	useTerminalStore.setState(initialTerminals, true);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("useTerminalEvents", () => {
	it("marks an exited shell, leaves Claude mode, and removes the terminal two seconds later", async () => {
		withTerminals({ isClaudeMode: true, status: "claude-active" }, {});
		const onExit = vi.fn();
		renderHook(() => useTerminalEvents({ terminalId: "term-1", onExit }));
		emit("onTerminalExit", "term-2", 0);
		expect(onExit).not.toHaveBeenCalled();

		emit("onTerminalExit", "term-1", 130);
		expect(terminal()?.status).toBe("exited");
		expect(terminal()?.isClaudeMode).toBe(false);
		expect(onExit).toHaveBeenCalledWith(130);
		act(() => vi.advanceTimersByTime(1999));
		expect(terminal()).toBeTruthy();
		act(() => vi.advanceTimersByTime(1));
		expect(terminal()).toBeUndefined();
		expect(destroyTerminal).toHaveBeenCalledWith("term-1");
		expect(terminal("term-2")).toBeTruthy();
	});

	it("keeps a terminal that came back within the two seconds, and survives a failed cleanup", async () => {
		renderHook(() => useTerminalEvents({ terminalId: "term-1" }));
		emit("onTerminalExit", "term-1", 1);
		expect(terminal()?.isClaudeMode).toBeFalsy();
		act(() => useTerminalStore.getState().setTerminalStatus("term-1", "running"));
		act(() => vi.advanceTimersByTime(2000));
		expect(terminal()?.status).toBe("running");
		expect(destroyTerminal).not.toHaveBeenCalled();

		destroyTerminal.mockRejectedValue(new Error("already gone"));
		emit("onTerminalExit", "term-1", 1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		expect(terminal()).toBeUndefined();
	});

	it("does not treat the end of a deliberate recreation as an exit", () => {
		const onExit = vi.fn();
		const isRecreatingRef = { current: true };
		renderHook(() => useTerminalEvents({ terminalId: "term-1", isRecreatingRef, onExit }));
		emit("onTerminalExit", "term-1", 0);
		expect(onExit).toHaveBeenCalledWith(0);
		expect(terminal()?.status).toBe("running");
		act(() => vi.advanceTimersByTime(5000));
		expect(terminal()).toBeTruthy();
	});

	it("calls the latest exit callback without subscribing again", () => {
		const first = vi.fn();
		const second = vi.fn();
		const view = renderHook(({ onExit }) => useTerminalEvents({ terminalId: "term-1", onExit }), {
			initialProps: { onExit: first },
		});
		view.rerender({ onExit: second });
		expect(unsubscribed).toEqual([]);
		emit("onTerminalExit", "term-1", 2);
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledWith(2);
	});

	it("follows its title, worktree, busy state and pending resume", () => {
		renderHook(() => useTerminalEvents({ terminalId: "term-1" }));
		const config = { name: "cart", worktreePath: "/work/.worktrees/cart" } as TerminalWorktreeConfig;
		for (const id of ["term-2", "term-1"]) {
			emit("onTerminalTitleChange", id, "vim README.md");
			emit("onTerminalWorktreeConfigChange", id, config);
			emit("onTerminalClaudeBusy", id, true);
			emit("onTerminalPendingResume", id, "session-7");
		}
		expect(terminal()).toMatchObject({
			title: "vim README.md",
			worktreeConfig: config,
			isClaudeBusy: true,
			pendingClaudeResume: true,
		});
		expect(terminal("term-2")).toMatchObject({ title: "Shell 2" });
		expect(terminal("term-2")?.worktreeConfig).toBeUndefined();
		expect(terminal("term-2")?.pendingClaudeResume).toBeFalsy();
	});

	it("enters Claude mode with the captured session, and leaves it when Claude exits", () => {
		renderHook(() => useTerminalEvents({ terminalId: "term-1" }));
		emit("onTerminalClaudeSession", "term-2", "other");
		emit("onTerminalClaudeSession", "term-1", "session-7");
		expect(terminal()).toMatchObject({ claudeSessionId: "session-7", isClaudeMode: true });
		expect(terminal("term-2")?.claudeSessionId).toBeUndefined();

		emit("onTerminalClaudeBusy", "term-1", true);
		emit("onTerminalClaudeExit", "term-2");
		expect(terminal()?.isClaudeMode).toBe(true);
		emit("onTerminalClaudeExit", "term-1");
		expect(terminal()).toMatchObject({ isClaudeMode: false, status: "running" });
		expect(terminal()?.isClaudeBusy).toBeUndefined();
		expect(terminal()?.claudeSessionId).toBeUndefined();
	});

	it("keeps an exited terminal exited when Claude's exit arrives after the shell's", () => {
		renderHook(() => useTerminalEvents({ terminalId: "term-1" }));
		emit("onTerminalExit", "term-1", 0);
		emit("onTerminalClaudeExit", "term-1");
		expect(terminal()?.status).toBe("exited");
	});

	it("unsubscribes from every channel when it goes away", () => {
		const view = renderHook(() => useTerminalEvents({ terminalId: "term-1" }));
		view.unmount();
		expect([...unsubscribed].sort()).toEqual([...CHANNELS].sort());
	});
});
