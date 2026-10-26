/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import type { Task } from "../../../shared/types";
import { draftToGoal, GoalCard } from "./GoalCard";

const task: Task = {
	id: "task-1",
	specId: "spec-1",
	projectId: "project-1",
	title: "Task with a goal",
	description: "",
	status: "human_review",
	subtasks: [],
	logs: [],
	createdAt: new Date("2026-10-26T08:00:00.000Z"),
	updatedAt: new Date("2026-10-26T09:00:00.000Z"),
};

const api = { getTaskGoal: vi.fn(), setTaskGoal: vi.fn() };
Object.defineProperty(window, "electronAPI", { value: api, writable: true });

describe("GoalCard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.getTaskGoal.mockResolvedValue({ success: true, data: { goal: null } });
		api.setTaskGoal.mockImplementation(async (_id, goal) => ({ success: true, data: { goal } }));
	});

	it("sets a goal from the form, by the task id", async () => {
		render(<GoalCard task={task} />);
		fireEvent.click(screen.getByRole("button", { name: "Set a goal" }));
		fireEvent.change(screen.getByLabelText("Command"), { target: { value: "dotnet test" } });
		fireEvent.change(screen.getByLabelText("Cap (USD)"), { target: { value: "2.5" } });
		fireEvent.change(screen.getByLabelText("Paths the task may not change"), {
			target: { value: "tests/**\n" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(api.setTaskGoal).toHaveBeenCalledWith("task-1", {
				command: "dotnet test",
				expectedExit: 0,
				maxRounds: undefined,
				maxCostUsd: 2.5,
				timeoutSeconds: undefined,
				protected: ["tests/**"],
			}),
		);
		expect(await screen.findByText("dotnet test")).toBeInTheDocument();
	});

	it("shows the last verdict and what was spent", async () => {
		api.getTaskGoal.mockResolvedValue({ success: true, data: { goal: { command: "pytest", maxCostUsd: 5 } } });
		render(
			<GoalCard
				task={{
					...task,
					goal: { status: "budget", reason: "the task has spent $5.10 of its $5.00 cap", spentUsd: 5.1, spendComplete: false },
				}}
			/>,
		);
		expect(await screen.findByText("Cap reached")).toBeInTheDocument();
		expect(screen.getByText("the task has spent $5.10 of its $5.00 cap")).toBeInTheDocument();
		expect(screen.getByText(/at least \$5\.10/)).toBeInTheDocument();
	});

	it("shows the main process's refusal", async () => {
		api.setTaskGoal.mockResolvedValue({ success: false, error: 'Protected path "../x" may not contain ".."' });
		render(<GoalCard task={task} />);
		fireEvent.click(screen.getByRole("button", { name: "Set a goal" }));
		fireEvent.change(screen.getByLabelText("Command"), { target: { value: "npm test" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText('Protected path "../x" may not contain ".."')).toBeInTheDocument();
	});

	it("cannot be edited while a run is going", async () => {
		render(<GoalCard task={task} editable={false} />);
		await waitFor(() => expect(api.getTaskGoal).toHaveBeenCalled());
		expect(screen.queryByRole("button", { name: "Set a goal" })).not.toBeInTheDocument();
	});
});

describe("draftToGoal", () => {
	it("leaves empty fields out and splits the paths", () => {
		expect(
			draftToGoal({
				command: " make check ",
				expectedExit: "",
				maxRounds: "3",
				maxCostUsd: "",
				timeoutSeconds: "",
				protected: "tests/**, scripts/check.sh",
			}),
		).toEqual({
			command: "make check",
			expectedExit: 0,
			maxRounds: 3,
			maxCostUsd: undefined,
			timeoutSeconds: undefined,
			protected: ["tests/**", "scripts/check.sh"],
		});
	});
});
