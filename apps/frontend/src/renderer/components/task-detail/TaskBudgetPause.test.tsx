/**
 * @vitest-environment jsdom
 */
/** A task the backend paused for its cost budget: why, and how to go on (#355). */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import "../../../shared/i18n";

const resumeTask = vi.fn();
vi.mock("../../stores/task-store", () => ({ resumeTask: (id: string) => resumeTask(id) }));
vi.mock("../../hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import type { BudgetPauseDetail, Task } from "../../../shared/types";
import { budgetPause, suggestedLimit, TaskBudgetPause } from "./TaskBudgetPause";

function task(reason: string | undefined, budget?: BudgetPauseDetail): Task {
	return {
		id: "t1",
		projectId: "p1",
		metadata: { paused: { enabled: true, paused_at: null, paused_subtask_id: null, reason, budget } },
	} as unknown as Task;
}

afterEach(() => {
	vi.unstubAllGlobals();
	resumeTask.mockReset();
});

describe("TaskBudgetPause", () => {
	it("shows nothing for the user's own pause", () => {
		const { container } = render(<TaskBudgetPause task={task(undefined)} />);
		expect(container).toBeEmptyDOMElement();
		expect(budgetPause(task("budget"))).toBeNull(); // no detail, no claim
	});

	it("raises the task's limit, then resumes it", async () => {
		const setTaskBudget = vi.fn().mockResolvedValue({ success: true });
		vi.stubGlobal("electronAPI", { setTaskBudget });
		resumeTask.mockResolvedValue(true);
		render(<TaskBudgetPause task={task("budget", { scope: "task", spentUsd: 4.2, limitUsd: 4 })} />);
		fireEvent.click(screen.getByTestId("task-budget-pause"));
		const input = await screen.findByLabelText(/new limit/i);
		expect(input).toHaveValue(6);
		fireEvent.change(input, { target: { value: "8" } });
		fireEvent.click(screen.getByRole("button", { name: /raise and resume/i }));
		await waitFor(() => expect(resumeTask).toHaveBeenCalledWith("t1"));
		expect(setTaskBudget).toHaveBeenCalledWith("p1", "t1", 8);
	});

	it("refuses a limit under what is already spent", async () => {
		const setTaskBudget = vi.fn();
		vi.stubGlobal("electronAPI", { setTaskBudget });
		render(<TaskBudgetPause task={task("budget", { scope: "task", spentUsd: 4.2, limitUsd: 4 })} />);
		fireEvent.click(screen.getByTestId("task-budget-pause"));
		fireEvent.change(await screen.findByLabelText(/new limit/i), { target: { value: "3" } });
		fireEvent.click(screen.getByRole("button", { name: /raise and resume/i }));
		expect(setTaskBudget).not.toHaveBeenCalled();
	});

	it("points to Costs for the project's budget and to the logs for a stall", async () => {
		render(<TaskBudgetPause task={task("budget", { scope: "project", spentUsd: 51, limitUsd: 50 })} />);
		fireEvent.click(screen.getByTestId("task-budget-pause"));
		expect(await screen.findByText(/raise the project's budget in costs/i)).toBeInTheDocument();
		expect(screen.queryByLabelText(/new limit/i)).toBeNull();
	});

	it("suggests half again, at least a dollar over the spend", () => {
		expect(suggestedLimit({ scope: "task", spentUsd: 4.2, limitUsd: 4 })).toBe(6);
		expect(suggestedLimit({ scope: "task", spentUsd: 9, limitUsd: 1 })).toBe(10);
	});
});
