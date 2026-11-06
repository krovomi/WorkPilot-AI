/** @vitest-environment jsdom */
/**
 * Guiding a running task: a message is sent to the next session or to one
 * subtask, and the card shows which session received it.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import type { Task } from "../../../../shared/types";
import type { SteeringMessage } from "../../../../shared/types/steering";
import { TaskSteeringPanel } from "../TaskSteeringPanel";

const task = {
	id: "task-1",
	status: "in_progress",
	subtasks: [
		{ id: "subtask-1", title: "Add the route", status: "completed" },
		{ id: "subtask-2", title: "Write the tests", status: "pending" },
	],
} as unknown as Task;

const delivered: SteeringMessage = {
	id: "a",
	text: "Use the existing repository",
	createdAt: "2026-11-06T10:00:00+00:00",
	source: "desktop",
	targetSubtaskId: null,
	deliveredAt: "2026-11-06T10:05:00+00:00",
	deliveredSession: 3,
	deliveredSubtaskId: "subtask-1",
};

const api = { listTaskSteering: vi.fn(), sendTaskSteering: vi.fn() };

beforeEach(() => {
	api.listTaskSteering.mockResolvedValue({ success: true, data: [delivered] });
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("TaskSteeringPanel", () => {
	it("shows which session received a message", async () => {
		render(<TaskSteeringPanel task={task} />);
		expect(await screen.findByText("Use the existing repository")).toBeInTheDocument();
		expect(screen.getByText(/Delivered to session 3, Add the route/)).toBeInTheDocument();
	});

	it("sends to one open subtask and shows it waiting", async () => {
		api.sendTaskSteering.mockResolvedValue({
			success: true,
			data: [
				delivered,
				{
					...delivered,
					id: "b",
					text: "Only here",
					targetSubtaskId: "subtask-2",
					deliveredAt: null,
					deliveredSession: null,
					deliveredSubtaskId: null,
				},
			],
		});
		render(<TaskSteeringPanel task={task} />);
		await screen.findByText("Use the existing repository");
		const select = screen.getByRole("combobox", { name: "Who receives it" });
		// A completed subtask is not offered.
		expect(screen.queryByRole("option", { name: "Add the route" })).toBeNull();
		fireEvent.change(select, { target: { value: "subtask-2" } });
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Only here" } });
		fireEvent.click(screen.getByRole("button", { name: /Send/ }));
		await waitFor(() =>
			expect(api.sendTaskSteering).toHaveBeenCalledWith("task-1", "Only here", "subtask-2"),
		);
		expect(await screen.findByText(/Waiting for the session of Write the tests/)).toBeInTheDocument();
	});

	it("says why a message was refused", async () => {
		api.sendTaskSteering.mockResolvedValue({ success: false, error: "invalid_subtask" });
		render(<TaskSteeringPanel task={task} />);
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
		fireEvent.click(screen.getByRole("button", { name: /Send/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("This subtask does not exist.");
	});
});
