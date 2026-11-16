/**
 * Issue auto-fix: what the hook loads for a project, how batch events move it,
 * what saving and toggling the config do, and the five-minute poll that starts
 * a fix for each new issue while auto-fix is on.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoFix } from "../useAutoFix";

type Handler = (...args: unknown[]) => void;
let github: Record<string, ReturnType<typeof vi.fn>>;
let handlers: Record<string, Handler>;
const cleanups: Record<string, ReturnType<typeof vi.fn>> = {};

const config = (enabled: boolean) => ({ enabled, labels: ["auto-fix"] });
const batch = (id: string, status: string) => ({ id, status });

function listener(name: string) {
	cleanups[name] = vi.fn();
	return vi.fn((handler: Handler) => {
		handlers[name] = handler;
		return cleanups[name];
	});
}

beforeEach(() => {
	handlers = {};
	github = {
		getAutoFixConfig: vi.fn().mockResolvedValue(config(false)),
		getAutoFixQueue: vi.fn().mockResolvedValue([{ issueNumber: 4, status: "building" }]),
		getBatches: vi.fn().mockResolvedValue([
			batch("a", "analyzing"),
			batch("b", "creating_spec"),
			batch("c", "building"),
			batch("d", "qa_review"),
			batch("e", "completed"),
		]),
		saveAutoFixConfig: vi.fn().mockResolvedValue(true),
		batchAutoFix: vi.fn(),
		checkNewIssues: vi.fn().mockResolvedValue([]),
		startAutoFix: vi.fn(),
		onAutoFixComplete: listener("onAutoFixComplete"),
		onBatchProgress: listener("onBatchProgress"),
		onBatchComplete: listener("onBatchComplete"),
		onBatchError: listener("onBatchError"),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = { github };
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function mounted(projectId: string | null = "p1") {
	const hook = renderHook(() => useAutoFix(projectId ?? undefined));
	await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
	return hook;
}

describe("loading", () => {
	it("loads the config, the queue and the batches, and counts the active batches", async () => {
		const { result } = await mounted();
		expect(github.getAutoFixConfig).toHaveBeenCalledWith("p1");
		expect(result.current).toMatchObject({ config: config(false), activeBatchCount: 4 });
		expect(result.current.getQueueItem(4)).toEqual({ issueNumber: 4, status: "building" });
		expect(result.current.getQueueItem(5)).toBeNull();
	});

	it("keeps empty state when loading fails", async () => {
		vi.spyOn(console, "error").mockReturnValue(undefined);
		github.getBatches.mockRejectedValue(new Error("offline"));
		const { result } = await mounted();
		expect(result.current).toMatchObject({ config: null, queue: [], batches: [] });
	});

	it("does nothing and listens to nothing without a project", async () => {
		const { result } = await mounted(null);
		expect(github.getAutoFixConfig).not.toHaveBeenCalled();
		expect(github.onBatchProgress).not.toHaveBeenCalled();
		expect(await result.current.saveConfig(config(true) as never)).toBe(false);
		expect(await result.current.toggleAutoFix(true)).toBe(false);
		act(() => result.current.startBatchAutoFix([1]));
		expect(github.batchAutoFix).not.toHaveBeenCalled();
	});
});

describe("events", () => {
	it("rereads the queue when a fix of this project completes", async () => {
		await mounted();
		github.getAutoFixQueue.mockClear().mockResolvedValue([]);
		act(() => handlers.onAutoFixComplete("other"));
		expect(github.getAutoFixQueue).not.toHaveBeenCalled();
		act(() => handlers.onAutoFixComplete("p1"));
		expect(github.getAutoFixQueue).toHaveBeenCalledWith("p1");
	});

	it("follows a batch run from start to completion", async () => {
		const { result } = await mounted();
		act(() => result.current.startBatchAutoFix([1, 2]));
		expect(github.batchAutoFix).toHaveBeenCalledWith("p1", [1, 2]);
		expect(result.current).toMatchObject({ isBatchRunning: true, batchProgress: { phase: "analyzing", totalIssues: 2 } });

		const step = { phase: "batching", progress: 40 };
		act(() => handlers.onBatchProgress("other", { phase: "complete" }));
		act(() => handlers.onBatchProgress("p1", step));
		expect(result.current).toMatchObject({ isBatchRunning: true, batchProgress: step });

		act(() => handlers.onBatchProgress("p1", { phase: "complete", progress: 100 }));
		expect(result.current.isBatchRunning).toBe(false);

		act(() => result.current.startBatchAutoFix());
		expect(result.current.batchProgress?.totalIssues).toBe(0);
		act(() => handlers.onBatchComplete("other", []));
		act(() => handlers.onBatchComplete("p1", [batch("z", "building")]));
		expect(result.current).toMatchObject({ isBatchRunning: false, batchProgress: null, activeBatchCount: 1 });
	});

	it("stops a batch run on its error", async () => {
		const { result } = await mounted();
		act(() => result.current.startBatchAutoFix([1]));
		act(() => handlers.onBatchError("other", { error: "x" }));
		expect(result.current.isBatchRunning).toBe(true);
		act(() => handlers.onBatchError("p1", { error: "x" }));
		expect(result.current).toMatchObject({ isBatchRunning: false, batchProgress: null });
	});

	it("drops every listener on unmount", async () => {
		const { unmount } = await mounted();
		unmount();
		for (const cleanup of Object.values(cleanups)) expect(cleanup).toHaveBeenCalledOnce();
	});
});

describe("config", () => {
	it("keeps a saved config, and the old one when saving is refused or fails", async () => {
		vi.spyOn(console, "error").mockReturnValue(undefined);
		const { result } = await mounted();
		github.saveAutoFixConfig.mockResolvedValueOnce(false);
		await act(async () => expect(await result.current.toggleAutoFix(true)).toBe(false));
		expect(result.current.config).toEqual(config(false));

		github.saveAutoFixConfig.mockRejectedValueOnce(new Error("disk"));
		await act(async () => expect(await result.current.saveConfig(config(true) as never)).toBe(false));
		expect(result.current.config).toEqual(config(false));

		await act(async () => expect(await result.current.toggleAutoFix(true)).toBe(true));
		expect(github.saveAutoFixConfig).toHaveBeenLastCalledWith("p1", config(true));
		expect(result.current.config).toEqual(config(true));
	});

	it("cannot toggle before a config is loaded", async () => {
		github.getAutoFixConfig.mockResolvedValue(null);
		const { result } = await mounted();
		expect(await result.current.toggleAutoFix(true)).toBe(false);
		expect(github.saveAutoFixConfig).not.toHaveBeenCalled();
	});
});

describe("new issues", () => {
	it("starts a fix for each new issue on demand, only while auto-fix is on", async () => {
		const { result } = await mounted();
		await act(() => result.current.checkForNewIssues());
		expect(github.checkNewIssues).not.toHaveBeenCalled();

		await act(() => result.current.toggleAutoFix(true));
		github.checkNewIssues.mockResolvedValueOnce([{ number: 7 }, { number: 8 }]);
		await act(() => result.current.checkForNewIssues());
		expect(github.startAutoFix.mock.calls).toEqual([
			["p1", 7],
			["p1", 8],
		]);

		await act(() => result.current.checkForNewIssues());
		expect(github.startAutoFix).toHaveBeenCalledTimes(2);

		vi.spyOn(console, "error").mockReturnValue(undefined);
		github.checkNewIssues.mockRejectedValueOnce(new Error("rate limited"));
		await act(() => result.current.checkForNewIssues());
		expect(github.startAutoFix).toHaveBeenCalledTimes(2);
	});

	it("polls every five minutes while auto-fix is on, and stops when it is turned off", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.spyOn(console, "error").mockReturnValue(undefined);
		github.getAutoFixConfig.mockResolvedValue(config(true));
		const { result } = await mounted();
		github.checkNewIssues.mockResolvedValueOnce([{ number: 9 }]).mockRejectedValueOnce(new Error("x"));

		await act(() => vi.advanceTimersByTimeAsync(5 * 60 * 1000));
		expect(github.startAutoFix).toHaveBeenCalledWith("p1", 9);
		await act(() => vi.advanceTimersByTimeAsync(5 * 60 * 1000));
		await act(() => vi.advanceTimersByTimeAsync(5 * 60 * 1000));
		expect(github.checkNewIssues).toHaveBeenCalledTimes(3);
		expect(github.startAutoFix).toHaveBeenCalledOnce();

		await act(() => result.current.toggleAutoFix(false));
		await act(() => vi.advanceTimersByTimeAsync(10 * 60 * 1000));
		expect(github.checkNewIssues).toHaveBeenCalledTimes(3);
	});
});
