/**
 * Creating a task from an issue: the comments to carry over, then the run.
 * After a failed investigation the dialog must say why and let the user out:
 * it used to keep a disabled "Creating…" spinner with no way to close it.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubIssue } from "../../../../../shared/types";
import { InvestigationDialog } from "../InvestigationDialog";

const ISSUE = { number: 12, title: "Crash on save" } as GitHubIssue;
const COMMENTS = [
	{ id: 1, body: "Happens on Windows", user: { login: "ana" }, created_at: "2026-11-01T10:00:00Z" },
	{ id: 2, body: "Also on macOS", user: { login: "bo" }, created_at: "2026-11-02T10:00:00Z" },
];
const IDLE = { phase: "idle", progress: 0, message: "" };

const getIssueComments = vi.fn();

function renderDialog(props: Partial<React.ComponentProps<typeof InvestigationDialog>> = {}) {
	const handlers = { onOpenChange: vi.fn(), onStartInvestigation: vi.fn(), onClose: vi.fn() };
	render(
		<InvestigationDialog
			open
			selectedIssue={ISSUE}
			investigationStatus={IDLE}
			projectId="p1"
			{...handlers}
			{...props}
		/>,
	);
	return handlers;
}

describe("InvestigationDialog", () => {
	beforeEach(() => {
		getIssueComments.mockReset();
		getIssueComments.mockResolvedValue({ success: true, data: COMMENTS });
		Object.assign(globalThis.electronAPI, { getIssueComments });
	});

	it("carries every comment over unless some are left out", async () => {
		const { onStartInvestigation } = renderDialog();

		expect(screen.getByText("Issue #12: Crash on save")).toBeInTheDocument();
		expect(await screen.findByText("Select Comments to Include (2/2)")).toBeInTheDocument();
		expect(getIssueComments).toHaveBeenCalledWith("p1", 12);
		expect(screen.getByText("ana")).toBeInTheDocument();

		// The whole row picks the comment.
		await userEvent.click(screen.getByText("Happens on Windows"));
		expect(screen.getByText("Select Comments to Include (1/2)")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Create Task" }));
		expect(onStartInvestigation).toHaveBeenLastCalledWith([2]);

		await userEvent.click(screen.getByRole("button", { name: "Select All" }));
		expect(screen.getByText("Select Comments to Include (2/2)")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Deselect All" }));
		await userEvent.click(screen.getAllByRole("checkbox")[1]);
		await userEvent.click(screen.getByRole("button", { name: "Create Task" }));
		expect(onStartInvestigation).toHaveBeenLastCalledWith([2]);
	});

	it("says what the task holds when the issue has no comment", async () => {
		getIssueComments.mockResolvedValue({ success: true, data: [] });
		renderDialog();
		expect(await screen.findByText("• No comments (this issue has no comments)")).toBeInTheDocument();
	});

	it("does not pass a failed read for an issue without comments", async () => {
		getIssueComments.mockResolvedValue({ success: false, error: "Rate limited" });
		renderDialog();
		expect(await screen.findByText("Failed to load comments")).toBeInTheDocument();
		expect(screen.getByText("Rate limited")).toBeInTheDocument();
		expect(screen.queryByText("• No comments (this issue has no comments)")).not.toBeInTheDocument();
	});

	it("says the comments could not be read without a reason given", async () => {
		getIssueComments.mockResolvedValue({ success: false });
		renderDialog();
		expect(await screen.findByText("Failed to load comments")).toBeInTheDocument();
		expect(screen.queryByText("• No comments (this issue has no comments)")).not.toBeInTheDocument();
	});

	it("gives the reason a call failed with", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		getIssueComments.mockRejectedValue(new Error("IPC down"));
		renderDialog();
		expect(await screen.findByText("IPC down")).toBeInTheDocument();
	});

	it("says the comments could not be read when the call itself fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		getIssueComments.mockRejectedValue("dropped");
		renderDialog();
		expect(await screen.findByText("Failed to load comments")).toBeInTheDocument();
	});

	it("reads nothing while closed or without a project", async () => {
		renderDialog({ open: false });
		renderDialog({ projectId: undefined });
		await waitFor(() => expect(getIssueComments).not.toHaveBeenCalled());
	});

	it("follows the run, then closes on an error or when it is done", async () => {
		const { onClose, onOpenChange } = renderDialog({
			investigationStatus: { phase: "creating", progress: 40, message: "Writing the spec" },
		});
		expect(screen.getByText("Writing the spec")).toBeInTheDocument();
		expect(screen.getByText("40%")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
		expect(onClose).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("says the task was created", async () => {
		const { onClose } = renderDialog({
			investigationStatus: { phase: "complete", progress: 100, message: "Done" },
		});
		expect(screen.getByText("Task created! View it in your Kanban board.")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(onClose).toHaveBeenCalled();
	});

	it("cancels from the first step", async () => {
		const { onOpenChange } = renderDialog();
		await screen.findByText("Select Comments to Include (2/2)");
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("shows the error and a Close button in the error phase", () => {
		const onClose = vi.fn();
		render(
			<InvestigationDialog
				open
				onOpenChange={vi.fn()}
				selectedIssue={null}
				investigationStatus={{
					phase: "error",
					progress: 0,
					message: "gh: rate limited",
					error: "gh: rate limited",
				}}
				onStartInvestigation={vi.fn()}
				onClose={onClose}
			/>,
		);
		expect(screen.getByText("gh: rate limited")).toBeTruthy();
		expect(screen.queryByText(/creating/i)).toBeNull();
		// The footer's Close, not the dialog's corner X.
		const footerClose = screen
			.getAllByRole("button", { name: /close/i })
			.find((b) => b.textContent?.trim());
		expect(footerClose).toBeTruthy();
		fireEvent.click(footerClose as HTMLElement);
		expect(onClose).toHaveBeenCalled();
	});
});
