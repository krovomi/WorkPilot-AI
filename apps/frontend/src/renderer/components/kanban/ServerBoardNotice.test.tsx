import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../stores/project-store";
import { useTaskStore } from "../../stores/task-store";
import { SERVER_BOARD_REFRESH_MS, useServerBoardRefresh } from "./ServerBoardNotice";

const getTasks = vi.fn();

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
		getTasks,
	};
	useProjectStore.setState({ selectedProjectId: "p-1" });
	useTaskStore.setState({ tasks: [] });
	getTasks.mockReset();
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
});
