/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import type { AppliedLessonsState, Task } from "../../../shared/types";
import { AppliedLessonsCard } from "./AppliedLessonsCard";

const task: Task = {
	id: "task-1",
	specId: "spec-1",
	projectId: "project-1",
	title: "Fix the refund crash",
	description: "",
	status: "in_progress",
	subtasks: [],
	logs: [],
	createdAt: new Date("2026-11-14T08:00:00.000Z"),
	updatedAt: new Date("2026-11-14T09:00:00.000Z"),
};

const LESSONS: AppliedLessonsState = {
	lessons: [
		{
			id: "checkpoint-bug_fix-1",
			kind: "checkpoint",
			text: "Reproduce the bug in a failing automated test before changing the code.",
			agents: ["spec_writer"],
		},
		{ id: "a1b2c3d4e5f60718", kind: "rule", text: "Keep EF out of Domain.", agents: ["planner", "coder"] },
		{
			id: "lp-0123456789ab",
			kind: "pattern",
			text: "Run the migrations first.",
			agents: ["coder"],
			patternType: "failure",
			confidence: 0.8,
		},
	],
	disabled: [],
};

const api = { getAppliedLessons: vi.fn(), setLessonDisabled: vi.fn() };
Object.defineProperty(window, "electronAPI", { value: api, writable: true });

describe("AppliedLessonsCard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.getAppliedLessons.mockResolvedValue({ success: true, data: LESSONS });
		api.setLessonDisabled.mockImplementation(async (_task, id, off) => ({
			success: true,
			data: { ...LESSONS, disabled: off ? [id] : [] },
		}));
	});

	it("says how many lessons the task carried, and lists them on demand", async () => {
		render(<AppliedLessonsCard task={task} />);
		expect(await screen.findByText("3 lessons applied to this task")).toBeInTheDocument();
		expect(screen.queryByText("Keep EF out of Domain.")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Show" }));
		expect(screen.getByText("Keep EF out of Domain.")).toBeInTheDocument();
		expect(screen.getByText("Checkpoint")).toBeInTheDocument();
		expect(screen.getByText("to avoid")).toBeInTheDocument();
		expect(screen.getByText("confidence 0.80")).toBeInTheDocument();
		expect(screen.getAllByText("coder")).toHaveLength(2);
	});

	it("turns one lesson off for this task, and back on", async () => {
		render(<AppliedLessonsCard task={task} />);
		fireEvent.click(await screen.findByRole("button", { name: "Show" }));
		fireEvent.click(screen.getAllByRole("button", { name: "Turn off for this task" })[1]);
		await waitFor(() =>
			expect(api.setLessonDisabled).toHaveBeenCalledWith("task-1", "a1b2c3d4e5f60718", true),
		);
		expect(await screen.findByText("Off for this task")).toBeInTheDocument();
		expect(screen.getByText("1 turned off")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Turn back on" }));
		await waitFor(() =>
			expect(api.setLessonDisabled).toHaveBeenCalledWith("task-1", "a1b2c3d4e5f60718", false),
		);
	});

	it("says when the change was refused", async () => {
		api.setLessonDisabled.mockResolvedValue({ success: false, error: "denied" });
		render(<AppliedLessonsCard task={task} />);
		fireEvent.click(await screen.findByRole("button", { name: "Show" }));
		fireEvent.click(screen.getAllByRole("button", { name: "Turn off for this task" })[0]);
		expect(await screen.findByText("Could not update the lesson: denied")).toBeInTheDocument();
	});

	it("shows nothing when no prompt carried a lesson", async () => {
		api.getAppliedLessons.mockResolvedValue({ success: true, data: { lessons: [], disabled: [] } });
		const { container } = render(<AppliedLessonsCard task={task} />);
		await waitFor(() => expect(api.getAppliedLessons).toHaveBeenCalledWith("task-1"));
		expect(container).toBeEmptyDOMElement();
	});
});
