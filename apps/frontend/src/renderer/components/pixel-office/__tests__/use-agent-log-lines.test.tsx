/**
 * The Pixel Office bubble shows a task's real log: the phase log (local or
 * server), watched while the bubble is open, and the live output only until
 * that log has something. A finished card with no live output — a card a page
 * opened, a server card, any task after a restart — used to stay on
 * "waiting for logs".
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskLogs } from "../../../../shared/types";
import { resetTaskLogWatchesForTests } from "../../../lib/task-log-watch";
import { useTaskStore } from "../../../stores/task-store";
import { cleanLogLines, useAgentLogLines } from "../use-agent-log-lines";

function logs(entries: string[]): TaskLogs {
	const phase = (name: "planning" | "coding" | "validation", list: string[]) => ({
		phase: name,
		status: "completed" as const,
		started_at: null,
		completed_at: null,
		entries: list.map((content) => ({
			timestamp: "2026-11-14T10:00:00Z",
			type: "text" as const,
			content,
			phase: name,
		})),
	});
	return {
		spec_id: "001-a",
		created_at: "",
		updated_at: "",
		phases: {
			planning: phase("planning", []),
			coding: phase("coding", entries),
			validation: phase("validation", []),
		},
	};
}

const getTaskLogs = vi.fn();
const watchTaskLogs = vi.fn(async () => ({ success: true }));
const unwatchTaskLogs = vi.fn(async () => ({ success: true }));
let changed: ((specId: string, logs: TaskLogs) => void) | null = null;
const onTaskLogsChanged = vi.fn((cb: (specId: string, logs: TaskLogs) => void) => {
	changed = cb;
	return () => {
		changed = null;
	};
});

function setTask(patch: Partial<Task>) {
	useTaskStore.setState({
		tasks: [
			{
				id: "t1",
				specId: "001-a",
				projectId: "p1",
				title: "Tests générés : order_service.py",
				status: "human_review",
				logs: [],
				subtasks: [],
				...patch,
			} as unknown as Task,
		],
	});
}

beforeEach(() => {
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		getTaskLogs,
		watchTaskLogs,
		unwatchTaskLogs,
		onTaskLogsChanged,
	};
	getTaskLogs.mockResolvedValue({ success: true, data: logs(["Unit tests", "Commit : test: add"]) });
});

afterEach(() => {
	resetTaskLogWatchesForTests();
	useTaskStore.setState({ tasks: [] });
	vi.clearAllMocks();
});

describe("useAgentLogLines", () => {
	it("shows a finished task's recorded log without any live output", async () => {
		setTask({});
		const { result } = renderHook(() => useAgentLogLines("t1"));
		await waitFor(() => expect(result.current.lines).toEqual(["Unit tests", "Commit : test: add"]));
		expect(getTaskLogs).toHaveBeenCalledWith("p1", "001-a");
		expect(result.current.running).toBe(false);
	});

	it("prefers the phase log even when live output exists", async () => {
		setTask({ status: "in_progress", logs: ["raw stdout"] } as Partial<Task>);
		const { result } = renderHook(() => useAgentLogLines("t1"));
		await waitFor(() => expect(result.current.lines).toEqual(["Unit tests", "Commit : test: add"]));
		expect(result.current.running).toBe(true);
	});

	it("falls back to the live output while the phase log is still empty", async () => {
		getTaskLogs.mockResolvedValue({ success: true, data: null });
		setTask({ status: "in_progress", logs: ["\u001b[32mStarting\u001b[0m", "  "] } as Partial<Task>);
		const { result } = renderHook(() => useAgentLogLines("t1"));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.lines).toEqual(["Starting"]);
	});

	it("follows the log while it grows and stops watching on close", async () => {
		setTask({ status: "in_progress" } as Partial<Task>);
		const { result, unmount } = renderHook(() => useAgentLogLines("t1"));
		await waitFor(() => expect(result.current.lines).toHaveLength(2));
		expect(watchTaskLogs).toHaveBeenCalledWith("p1", "001-a");

		act(() => changed?.("other-spec", logs(["not mine"])));
		expect(result.current.lines).toHaveLength(2);
		act(() => changed?.("001-a", logs(["Unit tests", "Commit : test: add", "QA passed"])));
		expect(result.current.lines.at(-1)).toBe("QA passed");

		unmount();
		expect(unwatchTaskLogs).toHaveBeenCalledWith("001-a");
	});

	it("says nothing is recorded instead of waiting, once the task is over", async () => {
		getTaskLogs.mockResolvedValue({ success: false, error: "Spec directory not found" });
		setTask({});
		const { result } = renderHook(() => useAgentLogLines("t1"));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.lines).toEqual([]);
		expect(result.current.running).toBe(false);
	});

	it("cleans lines", () => {
		expect(cleanLogLines(["", " a ", "\u001b[1mb\u001b[0m"])).toEqual(["a", "b"]);
	});
});
