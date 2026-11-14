/**
 * The task bubble offers "Stop" only to a task that is executing, and says
 * plainly when a finished task has no log instead of waiting forever.
 */
import { render, screen, waitFor } from "@testing-library/react";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../../shared/types";
import { resetTaskLogWatchesForTests } from "../../../lib/task-log-watch";
import type { PixelAgent } from "../../../stores/pixel-office-store";
import { useTaskStore } from "../../../stores/task-store";
import { AgentBubble } from "../AgentBubble";

const noop = () => undefined;

function bubble(agent: Partial<PixelAgent>) {
	return render(
		<AgentBubble
			agent={
				{
					id: "task:t1",
					type: "task",
					name: "Tests",
					fullName: "Tests générés : order_service.py",
					characterIndex: 0,
					seatIndex: 0,
					isClaudeMode: true,
					taskId: "t1",
					...agent,
				} as PixelAgent
			}
			terminal={undefined}
			anchorX={100}
			anchorY={100}
			onClose={noop}
			onGoToTerminal={noop}
			onGoToTask={noop}
			onKill={noop}
			onInterrupt={noop}
			onResumeClaude={noop}
			onSendCommand={noop}
			onStopTask={noop}
		/>,
	);
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		getTaskLogs: vi.fn(async () => ({ success: true, data: null })),
		watchTaskLogs: vi.fn(async () => ({ success: true })),
		unwatchTaskLogs: vi.fn(async () => ({ success: true })),
		onTaskLogsChanged: vi.fn(() => noop),
	};
});

afterEach(() => {
	resetTaskLogWatchesForTests();
	useTaskStore.setState({ tasks: [] });
});

function setTask(status: Task["status"]) {
	useTaskStore.setState({
		tasks: [
			{ id: "t1", specId: "001-a", projectId: "p1", status, logs: [], subtasks: [] } as unknown as Task,
		],
	});
}

describe("AgentBubble task panel", () => {
	it("does not offer to stop a task waiting for its human review", async () => {
		setTask("human_review");
		bubble({ activity: "waiting", phase: "complete", progress: 100 });
		expect(screen.queryByRole("button", { name: /^Stop$/ })).toBeNull();
		await waitFor(() =>
			expect(screen.getByText("No log was recorded for this task.")).toBeTruthy(),
		);
	});

	it("offers to stop a task that is executing, and waits for its log", async () => {
		setTask("in_progress");
		bubble({ activity: "typing", phase: "coding", progress: 40 });
		expect(screen.getByRole("button", { name: /Stop/ })).toBeTruthy();
		await waitFor(() => expect(screen.getByText("Waiting for logs…")).toBeTruthy());
	});

	it("shows the whole title on hover", () => {
		setTask("human_review");
		bubble({ activity: "waiting", phase: "complete" });
		expect(screen.getByTitle("Tests générés : order_service.py")).toBeTruthy();
	});
});
