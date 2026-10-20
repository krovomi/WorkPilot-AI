import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Task, TaskLogs } from "../../../../shared/types";
import { useTaskDetail } from "./useTaskDetail";

const settings = vi.hoisted(() => ({ order: "chronological" }));
beforeEach(() => { settings.order = "chronological"; });

vi.mock("../../../stores/project-store", () => ({ useProjectStore: () => null }));
vi.mock("../../../stores/settings-store", () => ({ useSettingsStore: () => settings.order }));
vi.mock("../../../stores/task-store", () => ({
  checkTaskRunning: vi.fn(), getTaskProgress: () => 0, hasRecentActivity: () => false,
  isIncompleteHumanReview: () => false, loadTasks: vi.fn(), useTaskStore: vi.fn(),
}));
const task = { id: "test", status: "backlog", subtasks: [], logs: [] } as unknown as Task;
afterEach(() => vi.useRealTimers());

it("does not force the viewport to the bottom when new logs arrive", () => {
 const { result } = renderHook(() => useTaskDetail({ task }));
 const container = document.createElement("div");
 container.scrollTop = 300;
 container.scrollTo = vi.fn();
 result.current.logsContainerRef.current = container;
 act(() => result.current.setActiveTab("logs"));
 act(() => result.current.setPhaseLogs({ phases: {} } as TaskLogs));
 expect(container.scrollTo).not.toHaveBeenCalled();
 expect(container.scrollTop).toBe(300);
});
