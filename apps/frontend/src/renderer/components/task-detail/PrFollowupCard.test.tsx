/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import type { PrFollowupStatus, Task } from "../../../shared/types";
import { PrFollowupCard } from "./PrFollowupCard";

const task: Task = {
	id: "task-1",
	specId: "spec-1",
	projectId: "project-1",
	title: "Task with a PR",
	description: "",
	status: "done",
	subtasks: [],
	logs: [],
	createdAt: new Date("2026-10-26T08:00:00.000Z"),
	updatedAt: new Date("2026-10-26T09:00:00.000Z"),
	metadata: { prUrl: "https://github.com/acme/app/pull/7" },
};

const reverted: PrFollowupStatus = {
	running: false,
	round: {
		decision: "fix",
		reason: "to fix: 1 failing check(s)",
		action: "reverted",
		head_sha: "a".repeat(40),
		pushed_sha: "",
		detail: "",
		failing: ["unit"],
		base_failing: ["e2e"],
		threads: [],
		violations: ["tests/test_app.py: pytest skip"],
		finished: true,
	},
};

const api = {
	getPrFollowupStatus: vi.fn(),
	onPrFollowupEvent: vi.fn(),
	startPrFollowup: vi.fn(),
	stopPrFollowup: vi.fn(),
};
Object.defineProperty(window, "electronAPI", { value: api, writable: true });

describe("PrFollowupCard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.getPrFollowupStatus.mockResolvedValue({ success: true, data: { running: false } });
		api.onPrFollowupEvent.mockReturnValue(() => {
			/* unsubscribe noop */
		});
		api.startPrFollowup.mockResolvedValue({ success: true, data: { running: true } });
	});

	it("renders nothing for a task without a PR", () => {
		const { container } = render(<PrFollowupCard task={{ ...task, metadata: {} }} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("starts the follow-through for the task, by its id only", async () => {
		render(<PrFollowupCard task={task} />);
		fireEvent.click(screen.getByRole("button", { name: "Follow the PR" }));
		await waitFor(() => expect(api.startPrFollowup).toHaveBeenCalledWith("task-1"));
		expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
	});

	it("says a fix was undone and why, and what is the base branch's", async () => {
		api.getPrFollowupStatus.mockResolvedValue({ success: true, data: reverted });
		render(<PrFollowupCard task={task} />);
		expect(
			await screen.findByText("Fix undone: it weakened a test or the pipeline"),
		).toBeInTheDocument();
		expect(screen.getByText("Undone before push: tests/test_app.py: pytest skip")).toBeInTheDocument();
		expect(screen.getByText("Red on the base branch too: e2e")).toBeInTheDocument();
	});

	it("shows the error the main process returned", async () => {
		api.startPrFollowup.mockResolvedValue({ success: false, error: "Python environment not ready" });
		render(<PrFollowupCard task={task} />);
		fireEvent.click(screen.getByRole("button", { name: "Follow the PR" }));
		expect(await screen.findByText("Python environment not ready")).toBeInTheDocument();
	});
});
