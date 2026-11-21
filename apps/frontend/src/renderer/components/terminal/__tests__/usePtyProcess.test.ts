/**
 * @vitest-environment jsdom
 *
 * The shell behind a terminal: created once its size is known, restored for a
 * terminal brought back from a saved session, created again after a
 * deliberate recreation (moving into a worktree), retried while that
 * recreation waits for a size, and reported when it fails.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "../../../stores/terminal-store";
import { useTerminalStore } from "../../../stores/terminal-store";
import { usePtyProcess } from "../usePtyProcess";

const initialTerminals = useTerminalStore.getState();
const CREATED_AT = new Date("2026-11-01T10:00:00.000Z");

const api = {
	createTerminal: vi.fn(),
	restoreTerminalSession: vi.fn(),
};

function withTerminal(overrides: Partial<Terminal> = {}) {
	useTerminalStore.setState({
		terminals: [
			{
				id: "term-1",
				title: "Shell 1",
				cwd: "/work/shop",
				status: "idle",
				isClaudeMode: false,
				createdAt: CREATED_AT,
				...overrides,
			} as Terminal,
		],
	});
}

const state = () => useTerminalStore.getState().terminals[0];

interface Props {
	cwd?: string;
	projectPath?: string | null;
	cols?: number;
	skipCreation?: boolean;
	isRecreatingRef?: RefObject<boolean>;
}

const onCreated = vi.fn();
const onError = vi.fn();

function pty(initial: Props = {}) {
	return renderHook(
		({ cwd = "/work/shop", projectPath = "/work/shop", cols = 80, skipCreation = false, isRecreatingRef }: Props) =>
			usePtyProcess({
				terminalId: "term-1",
				cwd,
				projectPath: projectPath ?? undefined,
				cols,
				rows: 24,
				skipCreation,
				isRecreatingRef,
				onCreated,
				onError,
			}),
		{ initialProps: initial },
	);
}

/** Lets time pass in small steps, so that each retry renders before the next. */
async function elapse(ms: number) {
	let passed = 0;
	do {
		const step = Math.min(50, ms - passed);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(step);
		});
		passed += step;
	} while (passed < ms);
}

beforeEach(() => {
	vi.resetAllMocks();
	api.createTerminal.mockResolvedValue({ success: true });
	api.restoreTerminalSession.mockResolvedValue({ success: true, data: { success: true } });
	Object.assign(globalThis.electronAPI, api);
	withTerminal();
});

afterEach(() => {
	useTerminalStore.setState(initialTerminals, true);
	vi.useRealTimers();
});

describe("usePtyProcess, a new terminal", () => {
	it("creates the shell once, with its size and folder, and marks it running", async () => {
		const view = pty();
		await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
		expect(api.createTerminal).toHaveBeenCalledWith({
			id: "term-1",
			cwd: "/work/shop",
			cols: 80,
			rows: 24,
			projectPath: "/work/shop",
		});
		expect(state().status).toBe("running");

		view.rerender({ cols: 120 });
		await act(async () => undefined);
		expect(api.createTerminal).toHaveBeenCalledOnce();
	});

	it("keeps its shell when the size goes away for a while", async () => {
		const view = pty();
		await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
		view.rerender({ skipCreation: true });
		view.rerender({ skipCreation: false });
		await act(async () => undefined);
		expect(api.createTerminal).toHaveBeenCalledOnce();
		expect(onCreated).toHaveBeenCalledOnce();
	});

	it("waits for a size before creating the shell", async () => {
		const view = pty({ skipCreation: true });
		await act(async () => undefined);
		expect(api.createTerminal).not.toHaveBeenCalled();
		view.rerender({ skipCreation: false });
		await waitFor(() => expect(api.createTerminal).toHaveBeenCalledOnce());
	});

	it("attaches at once to a shell already running, without waiting for a size", async () => {
		for (const status of ["running", "claude-active"] as const) {
			vi.resetAllMocks();
			withTerminal({ status });
			const view = pty({ skipCreation: true });
			await act(async () => undefined);
			expect(onCreated).toHaveBeenCalledOnce();
			expect(api.createTerminal).not.toHaveBeenCalled();
			view.rerender({ skipCreation: false });
			await act(async () => undefined);
			expect(api.createTerminal).not.toHaveBeenCalled();
			view.unmount();
		}
	});

	it("leaves the status of a shell the main process already started", async () => {
		withTerminal({ status: "claude-active" });
		pty();
		await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
		expect(state().status).toBe("claude-active");
	});

	it("reports a refusal or a failure, and tries again only when asked", async () => {
		api.createTerminal
			.mockResolvedValueOnce({ success: false, error: "shell not found" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("ipc closed"));
		const view = pty();
		await waitFor(() => expect(onError).toHaveBeenLastCalledWith("shell not found"));
		act(() => view.result.current.resetForRecreate());
		await waitFor(() => expect(onError).toHaveBeenLastCalledWith("Unknown error"));
		act(() => view.result.current.resetForRecreate());
		await waitFor(() => expect(onError).toHaveBeenLastCalledWith("ipc closed"));
		expect(onCreated).not.toHaveBeenCalled();
	});
});

describe("usePtyProcess, a restored terminal", () => {
	it("restores the saved session and clears the restored mark", async () => {
		vi.useFakeTimers({ now: new Date("2026-11-16T08:00:00.000Z"), shouldAdvanceTime: true });
		const worktreeConfig = { name: "cart", worktreePath: "/work/shop/.worktrees/cart" };
		withTerminal({
			isRestored: true,
			isClaudeMode: true,
			claudeSessionId: "session-7",
			cwd: "/work/shop/.worktrees/cart",
			worktreeConfig,
		} as Partial<Terminal>);
		pty();
		await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
		expect(api.restoreTerminalSession).toHaveBeenCalledWith(
			{
				id: "term-1",
				title: "Shell 1",
				cwd: "/work/shop/.worktrees/cart",
				projectPath: "/work/shop",
				isClaudeMode: true,
				claudeSessionId: "session-7",
				outputBuffer: "",
				createdAt: "2026-11-01T10:00:00.000Z",
				lastActiveAt: "2026-11-16T08:00:00.000Z",
				worktreeConfig,
			},
			80,
			24,
		);
		expect(api.createTerminal).not.toHaveBeenCalled();
		expect(state().status).toBe("claude-active");
		expect(state().isRestored).toBe(false);
	});

	it("marks a restored plain shell running, even outside a project", async () => {
		withTerminal({ isRestored: true });
		pty({ projectPath: null });
		await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
		expect(state().status).toBe("running");
		expect(api.restoreTerminalSession.mock.calls[0][0].projectPath).toBe("");
	});

	it("says why a session could not be restored", async () => {
		withTerminal({ isRestored: true });
		api.restoreTerminalSession
			.mockResolvedValueOnce({ success: true, data: { success: false, error: "session expired" } })
			.mockResolvedValueOnce({ success: false, error: "no such terminal" })
			.mockRejectedValueOnce(new Error("ipc closed"));
		const view = pty();
		await waitFor(() => expect(onError).toHaveBeenLastCalledWith("Error restoring session: session expired"));
		act(() => view.result.current.resetForRecreate());
		await waitFor(() => expect(onError).toHaveBeenLastCalledWith("Error restoring session: no such terminal"));
		act(() => view.result.current.resetForRecreate());
		await waitFor(() => expect(onError).toHaveBeenLastCalledWith("ipc closed"));
		expect(state().isRestored).toBe(true);
	});
});

describe("usePtyProcess, recreation", () => {
	it("creates the shell again in the new folder once the old one is gone", async () => {
		const isRecreatingRef = { current: false };
		const view = pty({ isRecreatingRef });
		await waitFor(() => expect(api.createTerminal).toHaveBeenCalledOnce());

		// Moving into a worktree: the folder changes while the old shell is destroyed.
		isRecreatingRef.current = true;
		act(() => view.result.current.prepareForRecreate());
		view.rerender({ cwd: "/work/shop/.worktrees/cart", isRecreatingRef });
		await act(async () => undefined);
		expect(api.createTerminal).toHaveBeenCalledOnce();
		act(() => useTerminalStore.getState().setTerminalStatus("term-1", "exited"));

		act(() => view.result.current.resetForRecreate());
		await waitFor(() => expect(api.createTerminal).toHaveBeenCalledTimes(2));
		expect(api.createTerminal).toHaveBeenLastCalledWith(
			expect.objectContaining({ cwd: "/work/shop/.worktrees/cart" }),
		);
		await waitFor(() => expect(state().status).toBe("running"));
		expect(isRecreatingRef.current).toBe(false);
	});

	it("creates the shell again when only the folder changes", async () => {
		const view = pty();
		await waitFor(() => expect(api.createTerminal).toHaveBeenCalledOnce());
		view.rerender({ cwd: "/work/other" });
		await waitFor(() => expect(api.createTerminal).toHaveBeenCalledTimes(2));
		expect(api.createTerminal).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: "/work/other" }));
	});

	it("retries while the size is not known, and creates as soon as it is", async () => {
		vi.useFakeTimers();
		const isRecreatingRef = { current: true };
		const view = pty({ skipCreation: true, isRecreatingRef });
		await elapse(500);
		expect(api.createTerminal).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
		view.rerender({ skipCreation: false, isRecreatingRef });
		await elapse(0);
		expect(api.createTerminal).toHaveBeenCalledOnce();
		expect(onCreated).toHaveBeenCalledOnce();
	});

	it("gives up after three seconds without a size", async () => {
		vi.useFakeTimers();
		const isRecreatingRef = { current: true };
		pty({ skipCreation: true, isRecreatingRef });
		await elapse(2_900);
		expect(onError).not.toHaveBeenCalled();
		await elapse(300);
		expect(onError).toHaveBeenCalledOnce();
		expect(onError).toHaveBeenCalledWith("Terminal recreation failed: dimensions not ready");
		expect(isRecreatingRef.current).toBe(false);
	});

	it("retries a failed recreation, and stops retrying once unmounted", async () => {
		vi.useFakeTimers();
		api.createTerminal.mockResolvedValueOnce({ success: false, error: "busy" });
		const isRecreatingRef = { current: true };
		const view = pty({ isRecreatingRef });
		await elapse(100);
		expect(api.createTerminal).toHaveBeenCalledTimes(2);
		expect(onError).not.toHaveBeenCalled();
		expect(onCreated).toHaveBeenCalledOnce();

		api.createTerminal.mockResolvedValue({ success: false, error: "busy" });
		isRecreatingRef.current = true;
		act(() => view.result.current.resetForRecreate());
		await elapse(0);
		const calls = api.createTerminal.mock.calls.length;
		view.unmount();
		await elapse(1_000);
		expect(api.createTerminal).toHaveBeenCalledTimes(calls);
	});
});
