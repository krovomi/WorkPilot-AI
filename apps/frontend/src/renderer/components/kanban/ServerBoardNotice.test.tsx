import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../stores/project-store";
import { useTaskStore } from "../../stores/task-store";
import {
	SERVER_BOARD_LIVE_REFRESH_MS,
	SERVER_BOARD_REFRESH_MS,
	useServerBoardRefresh,
} from "./ServerBoardNotice";

type Update = { projectId: string; live: boolean; changed: boolean };

const getTasks = vi.fn();
const watchServerBoard = vi.fn();
const unwatchServerBoard = vi.fn();
let pushUpdate: ((update: Update) => void) | null = null;
const offLive = vi.fn();

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
		getTasks,
		watchServerBoard,
		unwatchServerBoard,
		onServerBoardLive: (callback: (update: Update) => void) => {
			pushUpdate = callback;
			return offLive;
		},
	};
	useProjectStore.setState({ selectedProjectId: "p-1" });
	useTaskStore.setState({ tasks: [] });
	getTasks.mockReset();
	watchServerBoard.mockReset();
	unwatchServerBoard.mockReset();
	offLive.mockReset();
	pushUpdate = null;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useServerBoardRefresh", () => {
	it("reads the server board again while it is shown, and stops after", async () => {
		const card = { id: "server:p-1:001-x", specId: "001-x" };
		getTasks.mockResolvedValue({ success: true, data: [card] });
		const { unmount } = renderHook(() => useServerBoardRefresh("p-1"));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(SERVER_BOARD_REFRESH_MS);
		});
		expect(getTasks).toHaveBeenCalledWith("p-1");
		expect(useTaskStore.getState().tasks).toEqual([card]);

		unmount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(SERVER_BOARD_REFRESH_MS * 3);
		});
		expect(getTasks).toHaveBeenCalledTimes(1);
	});

	it("keeps the cards shown when a read fails or another project is selected", async () => {
		const shown = [{ id: "server:p-1:001-x", specId: "001-x" }];
		useTaskStore.setState({ tasks: shown as never });
		getTasks.mockResolvedValueOnce({ success: false, error: "offline" });
		renderHook(() => useServerBoardRefresh("p-1"));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(SERVER_BOARD_REFRESH_MS);
		});
		expect(useTaskStore.getState().tasks).toBe(shown);

		getTasks.mockResolvedValueOnce({ success: true, data: [] });
		useProjectStore.setState({ selectedProjectId: "local-1" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(SERVER_BOARD_REFRESH_MS);
		});
		expect(useTaskStore.getState().tasks).toBe(shown);
	});

	it("follows the live stream: reads at once on a change, less often while it is up", async () => {
		getTasks.mockResolvedValue({ success: true, data: [] });
		const { unmount } = renderHook(() => useServerBoardRefresh("p-1"));
		expect(watchServerBoard).toHaveBeenCalledWith("p-1");

		await act(async () => {
			pushUpdate?.({ projectId: "p-1", live: true, changed: true });
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(getTasks).toHaveBeenCalledTimes(1);

		// Another project's change is not this board's.
		await act(async () => {
			pushUpdate?.({ projectId: "p-2", live: true, changed: true });
			await vi.advanceTimersByTimeAsync(SERVER_BOARD_REFRESH_MS);
		});
		expect(getTasks).toHaveBeenCalledTimes(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(SERVER_BOARD_LIVE_REFRESH_MS);
		});
		expect(getTasks).toHaveBeenCalledTimes(2);

		// The stream drops: back to the short timer.
		await act(async () => {
			pushUpdate?.({ projectId: "p-1", live: false, changed: false });
			await vi.advanceTimersByTimeAsync(SERVER_BOARD_REFRESH_MS);
		});
		expect(getTasks).toHaveBeenCalledTimes(3);

		unmount();
		expect(offLive).toHaveBeenCalled();
		expect(unwatchServerBoard).toHaveBeenCalledWith("p-1");
	});

	it("keeps the cards shown when the server cannot be reached", async () => {
		const shown = [{ id: "server:p-1:001-x", specId: "001-x" }];
		useTaskStore.setState({ tasks: shown as never });
		getTasks.mockRejectedValueOnce(new Error("offline"));
		getTasks.mockResolvedValueOnce({ success: true, data: [] });
		renderHook(() => useServerBoardRefresh("p-1"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(SERVER_BOARD_REFRESH_MS);
		});
		expect(useTaskStore.getState().tasks).toBe(shown);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(SERVER_BOARD_REFRESH_MS);
		});
		expect(getTasks).toHaveBeenCalledTimes(2);
	});
});
