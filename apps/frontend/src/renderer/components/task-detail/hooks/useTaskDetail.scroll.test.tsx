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

it("follows each new log immediately even after scrolling away", () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useTaskDetail({ task }));
  const container = document.createElement("div");
  container.scrollTo = vi.fn();
  Object.defineProperty(container, "scrollHeight", { value: 1200 });
  result.current.logsContainerRef.current = container;
  act(() => result.current.setActiveTab("logs"));
  act(() => result.current.handleLogsScroll({ target: container } as unknown as React.UIEvent<HTMLDivElement>));
  vi.mocked(container.scrollTo).mockClear();
  act(() => result.current.setPhaseLogs({ phases: {} } as TaskLogs));
  expect(container.scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: "instant" });
});

it("follows legacy logs when the task receives another entry", () => {
  const { result, rerender } = renderHook(({ current }) => useTaskDetail({ task: current }), { initialProps: { current: task } });
  const container = document.createElement("div");
  container.scrollTo = vi.fn();
  Object.defineProperty(container, "scrollHeight", { value: 1500 });
  result.current.logsContainerRef.current = container;
  act(() => result.current.setActiveTab("logs"));
  vi.mocked(container.scrollTo).mockClear();
  rerender({ current: { ...task, logs: ["new output"] } });
  expect(container.scrollTo).toHaveBeenCalledWith({ top: 1500, behavior: "instant" });
});

it("keeps the frame at the bottom even when an earlier phase is active", () => {
  const { result } = renderHook(() => useTaskDetail({ task }));
  const container = document.createElement("div");
  const section = document.createElement("div");
  section.dataset.phaseSection = "planning";
  container.append(section);
  container.scrollTop = 100;
  Object.defineProperty(container, "scrollHeight", { value: 1200 });
  container.scrollTo = vi.fn();
  container.getBoundingClientRect = () => ({ top: 0, bottom: 400 }) as DOMRect;
  section.getBoundingClientRect = () => ({ top: 20, bottom: 650 }) as DOMRect;
  result.current.logsContainerRef.current = container;
  act(() => {
    result.current.setActiveTab("logs");
    result.current.setPhaseLogs({ phases: { planning: { status: "active", entries: [] } } } as unknown as TaskLogs);
  });
  expect(container.scrollTo).toHaveBeenLastCalledWith({ top: 1200, behavior: "instant" });
});

it("follows the top edge in reverse order", () => {
  settings.order = "reverse-chronological";
  const { result } = renderHook(() => useTaskDetail({ task }));
  const container = document.createElement("div");
  container.scrollTo = vi.fn();
  result.current.logsContainerRef.current = container;
  act(() => result.current.setActiveTab("logs"));
  expect(container.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "instant" });
});
