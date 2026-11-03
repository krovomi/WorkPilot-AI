/**
 * @vitest-environment jsdom
 */

/**
 * BlockedSubtaskHelp — what a blocked subtask needs, and the answers.
 *
 * Pinned: the reason and the advice for its kind are shown; each answer goes
 * to the main process with the task and subtask ids; a reply needs text; a
 * refusal code is translated.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Subtask } from "../../../../shared/types";

const mockToast = vi.fn();
const mockUnblock = vi.fn();

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${JSON.stringify(options)}` : key,
	}),
}));
vi.mock("../../../hooks/use-toast", () => ({
	useToast: () => ({ toast: mockToast }),
}));
vi.mock("../../../stores/subtask-unblock-actions", () => ({
	unblockSubtask: (...args: unknown[]) => mockUnblock(...args),
}));

import { BlockedSubtaskHelp } from "../BlockedSubtaskHelp";

const blocked: Subtask = {
	id: "subtask-2",
	title: "Verify test.txt",
	description: "Verify test.txt contains OK",
	status: "blocked",
	files: [],
	blockedReason: "Open the app on a phone",
	blockedKind: "needs_human",
};

beforeEach(() => {
	mockToast.mockReset();
	mockUnblock.mockReset();
	mockUnblock.mockResolvedValue({ success: true, restarted: false });
});

describe("BlockedSubtaskHelp", () => {
	it("says why and what to do for its kind", () => {
		render(<BlockedSubtaskHelp taskId="t1" subtask={blocked} />);
		expect(screen.getByText("tasks:subtasks.unblock.title.needs_human")).toBeInTheDocument();
		expect(
			screen.getByText(
				'tasks:subtasks.unblock.why:{"reason":"Open the app on a phone"}',
			),
		).toBeInTheDocument();
		expect(screen.getByText("tasks:subtasks.unblock.hint.needs_human")).toBeInTheDocument();
	});

	it("says so when the agent gave no reason", () => {
		render(
			<BlockedSubtaskHelp
				taskId="t1"
				subtask={{ ...blocked, blockedReason: undefined, blockedKind: undefined }}
			/>,
		);
		expect(screen.getByText("tasks:subtasks.unblock.noReason")).toBeInTheDocument();
		expect(screen.getByText("tasks:subtasks.unblock.title.agent")).toBeInTheDocument();
	});

	it("marks it done", async () => {
		render(<BlockedSubtaskHelp taskId="t1" subtask={blocked} />);
		fireEvent.click(screen.getByText("tasks:subtasks.unblock.actions.complete"));
		await waitFor(() =>
			expect(mockUnblock).toHaveBeenCalledWith("t1", "subtask-2", "complete", undefined),
		);
		await waitFor(() =>
			expect(mockToast).toHaveBeenCalledWith(
				expect.objectContaining({ title: "tasks:subtasks.unblock.done.complete" }),
			),
		);
	});

	it("sends a reply, which needs text", async () => {
		mockUnblock.mockResolvedValue({ success: true, restarted: true });
		render(<BlockedSubtaskHelp taskId="t1" subtask={blocked} />);
		fireEvent.click(screen.getByText("tasks:subtasks.unblock.actions.answer"));
		const send = screen.getByText("tasks:subtasks.unblock.sendReply").closest("button");
		expect(send).toBeDisabled();
		fireEvent.change(screen.getByLabelText("tasks:subtasks.unblock.replyLabel"), {
			target: { value: "It is in docs/" },
		});
		expect(send).not.toBeDisabled();
		fireEvent.click(send as HTMLButtonElement);
		await waitFor(() =>
			expect(mockUnblock).toHaveBeenCalledWith("t1", "subtask-2", "answer", "It is in docs/"),
		);
		await waitFor(() =>
			expect(mockToast).toHaveBeenCalledWith(
				expect.objectContaining({ description: "tasks:subtasks.unblock.restarted" }),
			),
		);
	});

	it("translates a refusal", async () => {
		mockUnblock.mockResolvedValue({ success: false, error: "task_running" });
		render(<BlockedSubtaskHelp taskId="t1" subtask={blocked} />);
		fireEvent.click(screen.getByText("tasks:subtasks.unblock.actions.retry"));
		await waitFor(() =>
			expect(mockToast).toHaveBeenCalledWith(
				expect.objectContaining({
					description: "tasks:subtasks.unblock.errors.task_running",
					variant: "destructive",
				}),
			),
		);
	});

	it("shows a failed subtask with the same answers", () => {
		render(
			<BlockedSubtaskHelp taskId="t1" subtask={{ ...blocked, status: "failed" }} />,
		);
		expect(screen.getByText("tasks:subtasks.unblock.title.failed")).toBeInTheDocument();
		expect(screen.getByText("tasks:subtasks.unblock.actions.skip")).toBeInTheDocument();
	});
});
