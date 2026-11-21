import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Task } from "../../../../shared/types";
import { useTaskDetail } from "./useTaskDetail";

const createTaskPR = vi.hoisted(() => vi.fn());
vi.mock("../create-task-pr", () => ({ createTaskPR }));
vi.mock("../../../stores/project-store", () => ({ useProjectStore: () => null }));
vi.mock("../../../stores/settings-store", () => ({ useSettingsStore: () => "chronological" }));
vi.mock("../../../stores/task-store", () => ({
	checkTaskRunning: vi.fn(),
	getTaskProgress: () => 0,
	hasRecentActivity: () => false,
	isIncompleteHumanReview: () => false,
	loadTasks: vi.fn(),
	useTaskStore: vi.fn(),
}));

const task = { id: "test", status: "backlog", subtasks: [], logs: [] } as unknown as Task;

it("creates the review's PR for its task, with its busy flag", async () => {
	createTaskPR.mockResolvedValue({ success: true });
	const { result } = renderHook(() => useTaskDetail({ task }));

	await expect(result.current.handleCreatePR({ draft: true })).resolves.toEqual({
		success: true,
	});
	expect(createTaskPR).toHaveBeenCalledWith(task, { draft: true }, expect.any(Function));
});
