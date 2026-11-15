/**
 * Auto-fix of single issues: settings and queue of the project shown, and,
 * while it is on, a look for new issues every five minutes.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoFix } from "../useAutoFix";

const CONFIG = {
	enabled: true,
	labels: ["autofix"],
	requireHumanApproval: true,
	model: "sonnet",
	thinkingLevel: "low",
};

type Listener = (...args: unknown[]) => void;
let completeListeners: Listener[];
let github: Record<string, ReturnType<typeof vi.fn>>;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("useAutoFix", () => {
	beforeEach(() => {
		completeListeners = [];
		github = {
			getAutoFixConfig: vi.fn().mockResolvedValue(CONFIG),
			getAutoFixQueue: vi.fn().mockResolvedValue([{ issueNumber: 4, status: "building" }]),
			saveAutoFixConfig: vi.fn().mockResolvedValue(true),
			checkNewIssues: vi.fn().mockResolvedValue([]),
			startAutoFix: vi.fn(),
			onAutoFixComplete: vi.fn((cb: Listener) => {
				completeListeners.push(cb);
				return () => {
					completeListeners = completeListeners.filter((l) => l !== cb);
				};
			}),
		};
		Object.assign(globalThis.electronAPI, { github });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("reads the settings and the queue of the project", async () => {
		const { result } = renderHook(() => useAutoFix("p1"));
		await waitFor(() => expect(result.current.config).toEqual(CONFIG));
		expect(result.current.getQueueItem(4)).toMatchObject({ status: "building" });
		expect(result.current.getQueueItem(5)).toBeNull();
	});

	it("reads nothing without a project", () => {
		const { result } = renderHook(() => useAutoFix(undefined));
		expect(result.current.config).toBeNull();
		expect(github.getAutoFixConfig).not.toHaveBeenCalled();
	});

	it("drops an answer that comes back for the previous project", async () => {
		const late = deferred<typeof CONFIG>();
		github.getAutoFixConfig.mockImplementation((projectId: string) =>
			projectId === "p1" ? late.promise : Promise.resolve({ ...CONFIG, enabled: false }),
		);
		const { result, rerender } = renderHook(({ id }) => useAutoFix(id), { initialProps: { id: "p1" } });
		rerender({ id: "p2" });
		await waitFor(() => expect(result.current.config).toMatchObject({ enabled: false }));

		await act(async () => late.resolve(CONFIG));
		expect(result.current.config).toMatchObject({ enabled: false });
	});

	it("keeps going when the settings cannot be read", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		github.getAutoFixConfig.mockRejectedValue(new Error("down"));
		const { result } = renderHook(() => useAutoFix("p1"));
		await waitFor(() => expect(error).toHaveBeenCalled());
		expect(result.current.config).toBeNull();
	});

	it("reads the queue again when one of its fixes ends", async () => {
		const { result } = renderHook(() => useAutoFix("p1"));
		await waitFor(() => expect(result.current.config).not.toBeNull());
		github.getAutoFixQueue.mockResolvedValue([{ issueNumber: 4, status: "completed" }]);

		await act(async () => {
			for (const cb of completeListeners) cb("p2");
		});
		expect(github.getAutoFixQueue).toHaveBeenCalledTimes(1);
		await act(async () => {
			for (const cb of completeListeners) cb("p1");
		});
		await waitFor(() => expect(result.current.getQueueItem(4)).toMatchObject({ status: "completed" }));

		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		github.getAutoFixQueue.mockRejectedValue(new Error("gone"));
		await act(async () => {
			for (const cb of completeListeners) cb("p1");
		});
		await waitFor(() => expect(error).toHaveBeenCalled());
	});

	it("drops a queue read again for a project no longer shown", async () => {
		const late = deferred<unknown[]>();
		const { result, rerender } = renderHook(({ id }) => useAutoFix(id), { initialProps: { id: "p1" } });
		await waitFor(() => expect(result.current.config).not.toBeNull());
		github.getAutoFixQueue.mockReturnValueOnce(late.promise);
		await act(async () => {
			for (const cb of completeListeners) cb("p1");
		});

		github.getAutoFixQueue.mockResolvedValue([]);
		rerender({ id: "p2" });
		await waitFor(() => expect(github.getAutoFixConfig).toHaveBeenCalledWith("p2"));
		await act(async () => late.resolve([{ issueNumber: 4, status: "failed" }]));
		expect(result.current.getQueueItem(4)).toBeNull();
	});

	it("turns auto-fix on and off, and keeps the settings when saving fails", async () => {
		const { result } = renderHook(() => useAutoFix("p1"));
		await waitFor(() => expect(result.current.config).not.toBeNull());

		await act(async () => {
			expect(await result.current.toggleAutoFix(false)).toBe(true);
		});
		expect(github.saveAutoFixConfig).toHaveBeenCalledWith("p1", { ...CONFIG, enabled: false });
		expect(result.current.config?.enabled).toBe(false);

		github.saveAutoFixConfig.mockResolvedValue(false);
		await act(async () => {
			expect(await result.current.toggleAutoFix(true)).toBe(false);
		});
		expect(result.current.config?.enabled).toBe(false);

		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		github.saveAutoFixConfig.mockRejectedValue(new Error("disk"));
		await act(async () => {
			expect(await result.current.saveConfig(CONFIG)).toBe(false);
		});
		expect(error).toHaveBeenCalled();
	});

	it("has nothing to toggle or save before the settings are read", async () => {
		github.getAutoFixConfig.mockReturnValue(new Promise(() => undefined));
		const { result } = renderHook(() => useAutoFix("p1"));
		expect(await result.current.toggleAutoFix(true)).toBe(false);

		const none = renderHook(() => useAutoFix(undefined));
		expect(await none.result.current.saveConfig(CONFIG)).toBe(false);
		await none.result.current.checkForNewIssues();
		expect(github.checkNewIssues).not.toHaveBeenCalled();
	});

	it("starts a fix for each new issue, now or every five minutes while on", async () => {
		vi.useFakeTimers();
		github.checkNewIssues.mockResolvedValue([{ number: 8 }, { number: 9 }]);
		const { result } = renderHook(() => useAutoFix("p1"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(result.current.config?.enabled).toBe(true);

		await act(async () => {
			await result.current.checkForNewIssues();
		});
		expect(github.startAutoFix.mock.calls).toEqual([
			["p1", 8],
			["p1", 9],
		]);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		});
		expect(github.startAutoFix).toHaveBeenCalledTimes(4);

		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		github.checkNewIssues.mockRejectedValue(new Error("offline"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
			await result.current.checkForNewIssues();
		});
		expect(error).toHaveBeenCalledTimes(2);

		// Off: no more looking.
		github.checkNewIssues.mockResolvedValue([{ number: 10 }]);
		await act(async () => {
			await result.current.toggleAutoFix(false);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
			await result.current.checkForNewIssues();
		});
		expect(github.startAutoFix).toHaveBeenCalledTimes(4);
	});

	it("stops looking when the view goes away", async () => {
		vi.useFakeTimers();
		const { unmount } = renderHook(() => useAutoFix("p1"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		unmount();
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(github.checkNewIssues).not.toHaveBeenCalled();
	});
});
