/**
 * TaskSubtasks — the plan's subtasks with their progress, and the plan editor:
 * a pending subtask can be reworded, removed or added, and nothing changes in
 * the task until the save succeeds.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callStub, resetStubs, stubModule, stubProps } from "../../../../__tests__/helpers/stub-component";
import i18n from "../../../../shared/i18n";
import type { Subtask, Task } from "../../../../shared/types";
import { TooltipProvider } from "../../ui/tooltip";
import { TaskSubtasks } from "../TaskSubtasks";

vi.mock("../PlanApprovalSection", () => stubModule("PlanApprovalSection"));
vi.mock("../TaskSteeringPanel", () => stubModule("TaskSteeringPanel"));
vi.mock("../TaskResetButton", () => stubModule("TaskResetButton"));
vi.mock("../SubtaskFilesViewer", () => stubModule("SubtaskFilesViewer"));
vi.mock("../TaskCodeEditor", () => stubModule("TaskCodeEditor"));
vi.mock("../BlockedSubtaskHelp", () => stubModule("BlockedSubtaskHelp", "HumanResolutionNote"));

function subtask(id: string, overrides: Partial<Subtask> = {}): Subtask {
	const text = overrides.description ?? `Do ${id}`;
	return { id, title: text, description: text, status: "pending", files: [], ...overrides };
}

function makeTask(subtasks: Subtask[], overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		specId: "001",
		projectId: "p1",
		title: "Task one",
		description: "",
		status: "in_progress",
		subtasks,
		logs: [],
		...overrides,
	} as Task;
}

const wrapper = ({ children }: { children: ReactNode }) => <TooltipProvider>{children}</TooltipProvider>;

function renderSubtasks(task: Task, onUpdatePlan?: (phases: unknown[]) => Promise<boolean>) {
	return render(<TaskSubtasks task={task} onUpdatePlan={onUpdatePlan} />, { wrapper });
}

afterEach(async () => {
	cleanup();
	resetStubs();
	vi.restoreAllMocks();
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

const PLAN = [
	subtask("a", { status: "completed", files: ["src/a.ts"] }),
	subtask("b", { files: ["src/one.ts", "src/two.ts", "lib/three.ts"] }),
	subtask("c", { status: "blocked", blockedReason: "Gave up" }),
	subtask("d", { status: "failed", description: "" }),
];

describe("TaskSubtasks", () => {
	it("says there is no subtask yet, with steering while the task runs", () => {
		renderSubtasks(makeTask([]));
		expect(screen.getByText("No subtasks defined")).toBeInTheDocument();
		expect(screen.getByTestId("stub-TaskSteeringPanel")).toBeInTheDocument();
		cleanup();
		renderSubtasks(makeTask([], { status: "done" }));
		expect(screen.queryByTestId("stub-TaskSteeringPanel")).toBeNull();
	});

	it("shows the progress, each subtask's files and where help is needed", async () => {
		await i18n.changeLanguage("fr");
		renderSubtasks(makeTask(PLAN, { status: "pr_created" }));
		expect(screen.getByText(/1 sur 4/)).toBeInTheDocument();
		expect(screen.getByText(/1 bloquée/)).toBeInTheDocument();
		expect(screen.getByText(/1 échouée/)).toBeInTheDocument();
		expect(screen.getByText("50%")).toBeInTheDocument();
		expect(screen.getByText("one.ts")).toBeInTheDocument();
		expect(screen.getByText("+1 de plus")).toBeInTheDocument();
		expect(screen.getAllByTestId("stub-BlockedSubtaskHelp")).toHaveLength(2);
		expect(screen.getByText("Sous-tâche sans titre")).toBeInTheDocument();
		expect(screen.queryByTestId("stub-TaskSteeringPanel")).toBeNull();
		expect(screen.queryByRole("button", { name: "Modifier le plan" })).toBeNull();
	});

	it("marks a change the person asked for", () => {
		renderSubtasks(
			makeTask([
				subtask("cr", { origin: "change_request", status: "in_progress", requestedAt: "2026-11-15T10:00:00Z" }),
			]),
		);
		expect(screen.getByText("Change requested")).toBeInTheDocument();
		expect(screen.getByText(/^Requested on /)).toBeInTheDocument();
	});

	it("opens a subtask's files by click or keyboard, and comes back", async () => {
		renderSubtasks(makeTask(PLAN));
		const [, second] = screen.getAllByRole("button", { name: /Do / });
		await userEvent.click(second);
		expect(stubProps("SubtaskFilesViewer")).toMatchObject({
			files: PLAN[1].files,
			subtaskTitle: "Do b",
			taskId: "t1",
		});
		act(() => {
			callStub("SubtaskFilesViewer", "onClose");
		});
		const first = screen.getAllByRole("button", { name: /Do / })[0];
		fireEvent.keyDown(first, { key: "Tab" });
		expect(screen.queryByTestId("stub-SubtaskFilesViewer")).toBeNull();
		fireEvent.keyDown(first.querySelector("span") as HTMLElement, { key: "Enter" });
		expect(screen.queryByTestId("stub-SubtaskFilesViewer")).toBeNull();
		fireEvent.keyDown(first, { key: " " });
		expect(stubProps("SubtaskFilesViewer").subtaskTitle).toBe("Do a");
	});

	it("edits a pending subtask's files and saves the whole plan", async () => {
		const onUpdatePlan = vi.fn(async () => false);
		renderSubtasks(makeTask(PLAN), onUpdatePlan);
		await userEvent.click(screen.getByRole("button", { name: "Edit files" }));
		expect(screen.getByText("Edit Files: Do b")).toBeInTheDocument();
		const trimmed = { ...PLAN[1], files: ["src/one.ts"] };
		await act(async () => {
			await callStub("TaskCodeEditor", "onUpdate", trimmed);
		});
		expect(onUpdatePlan).toHaveBeenCalledWith([
			{ name: "Implementation", subtasks: [PLAN[0], trimmed, PLAN[2], PLAN[3]] },
		]);
		// Refused: the editor stays open.
		expect(screen.getByTestId("stub-TaskCodeEditor")).toBeInTheDocument();
		onUpdatePlan.mockResolvedValueOnce(true);
		await act(async () => {
			await callStub("TaskCodeEditor", "onUpdate", trimmed);
		});
		expect(screen.queryByTestId("stub-TaskCodeEditor")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Edit files" }));
		await userEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(screen.queryByTestId("stub-TaskCodeEditor")).toBeNull();
	});

	it("rewords, removes and adds pending subtasks, without touching the task", async () => {
		const task = makeTask(PLAN);
		const before = structuredClone(task.subtasks);
		const onUpdatePlan = vi.fn(async () => true);
		vi.spyOn(Date, "now").mockReturnValue(42);
		renderSubtasks(task, onUpdatePlan);
		await userEvent.click(screen.getByRole("button", { name: "Edit Plan" }));
		expect(screen.queryByTestId("stub-TaskResetButton")).toBeNull();
		expect(screen.getByText("Only pending subtasks can be modified")).toBeInTheDocument();
		expect(screen.getByText("Untitled subtask")).toBeInTheDocument();

		const field = screen.getByRole("textbox", { name: "Description" });
		await userEvent.clear(field);
		expect(screen.getByText("Title cannot be empty")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
		await userEvent.type(field, "Add the model");
		await userEvent.click(screen.getByRole("button", { name: "Add Subtask" }));
		await userEvent.type(screen.getAllByRole("textbox", { name: "Description" })[1], "Write the docs");
		expect(task.subtasks).toEqual(before);

		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		expect(onUpdatePlan).toHaveBeenCalledWith([
			{
				name: "Implementation",
				subtasks: [
					PLAN[0],
					{ ...PLAN[1], title: "Add the model", description: "Add the model" },
					PLAN[2],
					PLAN[3],
					{ id: "new-42", title: "Write the docs", description: "Write the docs", status: "pending", files: [] },
				],
			},
		]);
		expect(task.subtasks).toEqual(before);
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("keeps the edits when the save is refused or fails, and cancel drops them", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const onUpdatePlan = vi
			.fn(async () => true)
			.mockResolvedValueOnce(false)
			.mockRejectedValueOnce(new Error("IPC"));
		renderSubtasks(makeTask([subtask("b"), subtask("e")]), onUpdatePlan);
		await userEvent.click(screen.getByRole("button", { name: "Edit Plan" }));
		expect(screen.queryByText("Only pending subtasks can be modified")).toBeNull();
		await userEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
		expect(screen.getAllByRole("textbox")).toHaveLength(1);
		const save = screen.getByRole("button", { name: "Save Changes" });
		await userEvent.click(save);
		expect(onUpdatePlan).toHaveBeenLastCalledWith([{ name: "Implementation", subtasks: [subtask("e")] }]);
		await userEvent.click(save);
		expect(error).toHaveBeenCalled();
		expect(screen.getAllByRole("textbox")).toHaveLength(1);

		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await userEvent.click(screen.getByRole("button", { name: "Edit Plan" }));
		expect(screen.getAllByRole("textbox")).toHaveLength(2);
	});

	it("shows that the plan is being saved", async () => {
		let finish: (saved: boolean) => void = () => undefined;
		const onUpdatePlan = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					finish = resolve;
				}),
		);
		renderSubtasks(makeTask([subtask("b")]), onUpdatePlan);
		await userEvent.click(screen.getByRole("button", { name: "Edit Plan" }));
		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		expect(screen.getByRole("button", { name: /Saving/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		await act(async () => finish(true));
		expect(screen.queryByRole("button", { name: /Saving/ })).toBeNull();
	});
});
