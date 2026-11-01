import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types/task";
import { pendingPlanApprovals, useSpecApprovalStore } from "../../stores/spec-approval-store";
import { SpecApprovalDashboard } from "./SpecApprovalDashboard";

const submitReview = vi.fn();
const startTask = vi.fn();
let tasks: Task[] = [];

vi.mock("../../stores/task-store", () => ({
	submitReview: (...args: unknown[]) => submitReview(...args),
	startTask: (...args: unknown[]) => startTask(...args),
	useTaskStore: (select: (s: { tasks: Task[] }) => unknown) => select({ tasks }),
}));
vi.mock("../../stores/project-store", () => ({
	useProjectStore: (select: (s: { getActiveProject: () => unknown }) => unknown) =>
		select({ getActiveProject: () => ({ id: "p1", path: "/repo" }) }),
}));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

function task(id: string, overrides: Partial<Task> = {}): Task {
	return {
		id,
		specId: `00${id}-feature-${id}`,
		projectId: "p1",
		title: `Task ${id}`,
		description: "",
		status: "human_review",
		reviewReason: "plan_review",
		subtasks: [],
		logs: [],
		createdAt: new Date("2026-11-01T10:00:00Z"),
		updatedAt: new Date("2026-11-01T10:00:00Z"),
		...overrides,
	} as Task;
}

const invoke = vi.fn();

describe("pendingPlanApprovals", () => {
	it("keeps only this project's tasks waiting on their plan, oldest first", () => {
		const list = pendingPlanApprovals(
			[
				task("1", { updatedAt: new Date("2026-11-01T12:00:00Z") }),
				task("2", { updatedAt: new Date("2026-11-01T09:00:00Z") }),
				task("3", { reviewReason: "completed" }),
				task("4", { status: "in_progress", reviewReason: undefined }),
				task("5", { projectId: "other" }),
			],
			"p1",
		);
		expect(list.map((t) => t.id)).toEqual(["2", "1"]);
	});

	it("is empty without a project", () => {
		expect(pendingPlanApprovals([task("1")], undefined)).toEqual([]);
	});
});

describe("SpecApprovalDashboard", () => {
	beforeEach(() => {
		submitReview.mockReset();
		startTask.mockReset();
		invoke.mockReset();
		invoke.mockResolvedValue({
			success: true,
			data: { spec_md: "# Spec body", implementation_plan_json: "{}" },
		});
		(globalThis as unknown as { electronAPI: unknown }).electronAPI = { invoke };
		useSpecApprovalStore.getState().clear();
		tasks = [task("1")];
	});

	it("lists the plans waiting and loads the selected spec", async () => {
		render(<SpecApprovalDashboard />);
		fireEvent.click(screen.getByText("Task 1"));
		await waitFor(() => expect(screen.getByText("# Spec body")).toBeInTheDocument());
		expect(invoke).toHaveBeenCalledWith("specApproval:getSpec", "/repo", "001-feature-1");
	});

	it("approves through the task's review channel, then starts the build", async () => {
		submitReview.mockResolvedValue(true);
		render(<SpecApprovalDashboard />);
		fireEvent.click(screen.getByText("Task 1"));
		await act(async () => {
			fireEvent.click(screen.getByText("specApproval:decision.approve"));
		});
		expect(submitReview).toHaveBeenCalledWith("1", true, undefined);
		expect(startTask).toHaveBeenCalledWith("1");
	});

	it("sends a change request with its feedback and does not start the build", async () => {
		submitReview.mockResolvedValue(true);
		render(<SpecApprovalDashboard />);
		fireEvent.click(screen.getByText("Task 1"));
		const request = screen.getByText("specApproval:decision.requestChanges");
		expect(request).toBeDisabled();
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "Split the endpoint" },
		});
		await act(async () => {
			fireEvent.click(request);
		});
		expect(submitReview).toHaveBeenCalledWith("1", false, "Split the endpoint");
		expect(startTask).not.toHaveBeenCalled();
	});

	it("says so when the decision is not saved, and starts nothing", async () => {
		submitReview.mockResolvedValue(false);
		render(<SpecApprovalDashboard />);
		fireEvent.click(screen.getByText("Task 1"));
		await act(async () => {
			fireEvent.click(screen.getByText("specApproval:decision.approve"));
		});
		expect(startTask).not.toHaveBeenCalled();
		expect(screen.getByText("specApproval:decision.failed")).toBeInTheDocument();
	});
});
