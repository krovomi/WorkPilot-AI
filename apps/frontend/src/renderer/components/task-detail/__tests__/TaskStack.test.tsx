/**
 * @vitest-environment jsdom
 */

/**
 * TaskStack — stacking a task on a blocker (F6).
 *
 * Pinned: a pending blocker offers "stack on"; the fields the main wrote reach
 * the store; a stacked task whose parent moved offers "update"; a conflict
 * lists its files; a server card shows nothing.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Task } from "../../../../shared/types";

const store = vi.hoisted(() => ({
	tasks: [] as unknown[],
	updateTask: vi.fn(),
}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${JSON.stringify(options)}` : key,
	}),
}));
vi.mock("../../../stores/task-store", () => {
	const useTaskStore = (select: (s: { tasks: unknown[] }) => unknown) =>
		select({ tasks: store.tasks });
	useTaskStore.getState = () => ({ updateTask: store.updateTask });
	return { useTaskStore };
});

import { TaskStack } from "../TaskStack";

const parent = { id: "task-a", specId: "001-a", title: "Login API", status: "human_review", metadata: {} };
const child = {
	id: "task-b",
	specId: "002-b",
	title: "Login page",
	status: "backlog",
	metadata: { blockedBy: ["task-a"] },
} as unknown as Task;

const api = {
	getTaskStackStatus: vi.fn(),
	stackTaskOn: vi.fn(),
	updateTaskStack: vi.fn(),
};

beforeEach(() => {
	store.tasks = [parent, child];
	store.updateTask.mockReset();
	for (const fn of Object.values(api)) fn.mockReset();
	(globalThis as unknown as { electronAPI: typeof api }).electronAPI = api;
});

describe("TaskStack", () => {
	it("stacks on a pending blocker and puts the fields in the store", async () => {
		api.getTaskStackStatus.mockResolvedValue({ success: true, data: { stacked: false } });
		api.stackTaskOn.mockResolvedValue({
			success: true,
			data: { baseBranch: "workpilot/001-a", stackParent: "001-a" },
		});
		render(<TaskStack task={child} />);
		const button = await screen.findByRole("button", { name: /stack\.stackOn/ });
		fireEvent.click(button);
		await waitFor(() => expect(api.stackTaskOn).toHaveBeenCalledWith("task-b", "task-a"));
		await waitFor(() =>
			expect(store.updateTask).toHaveBeenCalledWith("task-b", {
				metadata: {
					blockedBy: ["task-a"],
					baseBranch: "workpilot/001-a",
					stackParent: "001-a",
				},
			}),
		);
	});

	it("offers an update when the parent moved, and lists a conflict's files", async () => {
		api.getTaskStackStatus.mockResolvedValue({
			success: true,
			data: { stacked: true, parentTitle: "Login API", parentBranch: "workpilot/001-a", moved: true },
		});
		api.updateTaskStack.mockResolvedValue({
			success: false,
			error: "conflict",
			data: { outcome: "up_to_date", conflicts: ["src/login.ts"] },
		});
		render(<TaskStack task={child} />);
		expect(await screen.findByText("stack.parentMoved")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "stack.update" }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("stack.errors.conflict");
		expect(alert).toHaveTextContent("src/login.ts");
	});

	it("disables the update while an agent runs", async () => {
		api.getTaskStackStatus.mockResolvedValue({
			success: true,
			data: { stacked: true, parentBranch: "workpilot/001-a", parentMerged: true, nextBase: "main", running: true },
		});
		render(<TaskStack task={child} />);
		expect(await screen.findByRole("button", { name: /stack\.moveToBase/ })).toBeDisabled();
	});

	it("shows nothing for a server card", async () => {
		api.getTaskStackStatus.mockResolvedValue({ success: false, error: "local_only" });
		const { container } = render(<TaskStack task={child} />);
		await waitFor(() => expect(api.getTaskStackStatus).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});
});
