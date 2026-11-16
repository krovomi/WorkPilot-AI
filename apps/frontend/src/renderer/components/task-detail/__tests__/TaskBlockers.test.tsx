/**
 * TaskBlockers — the tasks this one waits for: pending, done or deleted, each
 * removable, and a picker that offers only tasks that cannot close a loop.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { Task } from "../../../../shared/types";
import { persistUpdateTask, useTaskStore } from "../../../stores/task-store";
import { TaskBlockers } from "../TaskBlockers";

const toast = vi.fn();
vi.mock("../../../hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("../../../stores/task-store", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	persistUpdateTask: vi.fn(),
}));

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
	return {
		id,
		specId: id,
		projectId: "p1",
		title: `Task ${id}`,
		description: "",
		status: "backlog",
		subtasks: [],
		logs: [],
		...overrides,
	} as Task;
}

const initial = useTaskStore.getState();
const jumpToTask = vi.fn();

function board(...tasks: Task[]) {
	useTaskStore.setState({ tasks, jumpToTask });
}

beforeEach(() => {
	vi.mocked(persistUpdateTask).mockResolvedValue(true);
});

afterEach(async () => {
	cleanup();
	vi.clearAllMocks();
	useTaskStore.setState(initial, true);
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

describe("TaskBlockers", () => {
	it("says there is no prerequisite, and has nothing to offer alone", () => {
		const task = makeTask("t1");
		board(task);
		render(<TaskBlockers task={task} />);
		expect(screen.getByText("No prerequisites.")).toBeInTheDocument();
		expect(screen.getByRole("combobox")).toBeDisabled();
	});

	it("shows pending, done and deleted prerequisites, and opens one", async () => {
		const task = makeTask("t1", { metadata: { blockedBy: ["t2", "t3", "gone", "t1"] } });
		board(
			task,
			makeTask("t2", { status: "in_progress" }),
			makeTask("t3", { status: "done" }),
		);
		render(<TaskBlockers task={task} />);
		expect(screen.queryByText("No prerequisites.")).toBeNull();
		expect(screen.getByText("Task t3")).toHaveClass("line-through");
		expect(screen.getByText("Task t2")).not.toHaveClass("line-through");
		expect(screen.getByText("gone (not found)")).toHaveAttribute(
			"title",
			"That task no longer exists; the prerequisite is ignored.",
		);
		await userEvent.click(screen.getByText("Task t2"));
		expect(jumpToTask).toHaveBeenCalledWith("t2");
	});

	it("removes a prerequisite, a deleted one too", async () => {
		const task = makeTask("t1", { metadata: { blockedBy: ["t2", "gone"] } });
		board(task, makeTask("t2"));
		render(<TaskBlockers task={task} />);
		await userEvent.click(screen.getByRole("button", { name: "Remove Task t2" }));
		expect(persistUpdateTask).toHaveBeenCalledWith("t1", { metadata: { blockedBy: ["gone"] } });
		await userEvent.click(screen.getByRole("button", { name: "Remove gone" }));
		expect(persistUpdateTask).toHaveBeenLastCalledWith("t1", { metadata: { blockedBy: ["t2"] } });
		expect(toast).not.toHaveBeenCalled();
	});

	it("adds a prerequisite from the picker, without a task that would make a loop", async () => {
		await i18n.changeLanguage("fr");
		const task = makeTask("t1");
		board(
			task,
			makeTask("t2", { status: "human_review" }),
			makeTask("t3", { metadata: { blockedBy: ["t1"] } }),
			makeTask("t4", { metadata: { archivedAt: "2026-11-01T00:00:00Z" } }),
			makeTask("t5", { status: "planning" as Task["status"] }),
		);
		render(<TaskBlockers task={task} />);
		await userEvent.click(screen.getByRole("combobox"));
		const list = screen.getByRole("listbox");
		const options = within(list).getAllByRole("option");
		expect(options.map((o) => o.textContent)).toEqual([
			expect.stringContaining("Task t2"),
			expect.stringContaining("Task t5"),
		]);
		expect(options[0]).toHaveTextContent("Révision humaine");
		expect(options[1]).toHaveTextContent("Planification");
		await userEvent.click(options[0]);
		expect(persistUpdateTask).toHaveBeenCalledWith("t1", { metadata: { blockedBy: ["t2"] } });
	});

	it("says when the prerequisites could not be saved", async () => {
		vi.mocked(persistUpdateTask).mockResolvedValueOnce(false);
		const task = makeTask("t1", { metadata: { blockedBy: ["t2"] } });
		board(task, makeTask("t2"));
		render(<TaskBlockers task={task} />);
		await userEvent.click(screen.getByRole("button", { name: "Remove Task t2" }));
		expect(toast).toHaveBeenCalledWith({
			title: "Could not save",
			description: "The prerequisites could not be saved.",
			variant: "destructive",
		});
	});
});
