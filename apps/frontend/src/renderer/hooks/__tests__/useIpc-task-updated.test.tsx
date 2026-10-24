/**
 * Main sends `task:updated` when a field of a task changes after the call that
 * started the work returned: the PR URL once the PR exists, the visual proof
 * once the emulator has run. Nothing listened to it (it was sent on the
 * `task:update` invoke channel), so both stayed invisible until a reload.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";
import { useProjectStore } from "../../stores/project-store";
import { useTaskStore } from "../../stores/task-store";
import { useIpcListeners } from "../useIpc";

type Listener = (...args: unknown[]) => void;

let listeners: Map<string, Listener>;

function stubElectronAPI(): void {
	listeners = new Map();
	const api = new Proxy(
		{},
		{
			get: (_target, name: string) => {
				if (/^on[A-Z]/.test(name)) {
					return (callback: Listener) => {
						listeners.set(name, callback);
						return () => listeners.delete(name);
					};
				}
				return vi.fn().mockResolvedValue({ success: true, data: undefined });
			},
		},
	);
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
}

const task = {
	id: "t1",
	specId: "001-spec",
	title: "A task",
	status: "human_review",
	metadata: { category: "feature" },
} as unknown as Task;

beforeEach(() => {
	stubElectronAPI();
	useTaskStore.setState({ tasks: [task] });
	useProjectStore.setState({ selectedProjectId: "p1" });
});

afterEach(() => {
	useTaskStore.setState({ tasks: [] });
});

describe("task:updated", () => {
	it("applies the PR URL to the task", () => {
		renderHook(() => useIpcListeners());
		act(() => {
			listeners.get("onTaskUpdated")?.(
				"t1",
				{ prUrl: "https://example.test/pr/1" },
				"p1",
			);
		});
		expect(useTaskStore.getState().tasks[0].prUrl).toBe(
			"https://example.test/pr/1",
		);
	});

	it("merges metadata instead of replacing it", () => {
		renderHook(() => useIpcListeners());
		act(() => {
			listeners.get("onTaskUpdated")?.(
				"t1",
				{ metadata: { visualProof: { status: "passed" } } },
				"p1",
			);
		});
		expect(useTaskStore.getState().tasks[0].metadata).toEqual({
			category: "feature",
			visualProof: { status: "passed" },
		});
	});

	it("ignores an update for another project", () => {
		renderHook(() => useIpcListeners());
		act(() => {
			listeners.get("onTaskUpdated")?.(
				"t1",
				{ prUrl: "https://example.test/pr/2" },
				"other",
			);
		});
		expect(useTaskStore.getState().tasks[0].prUrl).toBeUndefined();
	});
});
