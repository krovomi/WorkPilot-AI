/**
 * Creating a task from a GitLab issue: the notes to carry over, then the run.
 * Every line is in the app's language: the run shows its phase, not the main
 * process's English message, and a failure says so before what went wrong.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../../shared/i18n";
import type { GitLabInvestigationStatus, GitLabIssue, GitLabNote } from "../../../../../shared/types";
import { InvestigationDialog } from "../InvestigationDialog";

const ISSUE = { iid: 12, title: "Crash on save" } as GitLabIssue;
const note = (id: number, body: string, system = false): GitLabNote => ({
	id,
	body,
	author: { username: `user${id}` },
	createdAt: "2026-11-01T10:00:00Z",
	updatedAt: "2026-11-01T10:00:00Z",
	system,
});
const NOTES = [note(1, "Happens on Windows"), note(2, "changed the milestone", true), note(3, "Also on macOS")];
const IDLE: GitLabInvestigationStatus = { phase: "idle", progress: 0, message: "" };

const getGitLabIssueNotes = vi.fn();

function renderDialog(props: Partial<React.ComponentProps<typeof InvestigationDialog>> = {}) {
	const handlers = { onOpenChange: vi.fn(), onStartInvestigation: vi.fn(), onClose: vi.fn() };
	const view = render(
		<InvestigationDialog
			open
			selectedIssue={ISSUE}
			investigationStatus={IDLE}
			projectId="p1"
			{...handlers}
			{...props}
		/>,
	);
	return { ...handlers, ...view };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((ok, ko) => {
		resolve = ok;
		reject = ko;
	});
	return { promise, resolve, reject };
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	getGitLabIssueNotes.mockReset();
	getGitLabIssueNotes.mockResolvedValue({ success: true, data: NOTES });
	Object.assign(globalThis.electronAPI, { getGitLabIssueNotes });
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("InvestigationDialog (GitLab) — notes", () => {
	it("carries every person's note over unless some are left out", async () => {
		const { onStartInvestigation, onOpenChange } = renderDialog();
		expect(screen.getByText("Issue #12: Crash on save")).toBeInTheDocument();
		expect(await screen.findByText("Select Notes to Include (2/2)")).toBeInTheDocument();
		expect(getGitLabIssueNotes).toHaveBeenCalledWith("p1", 12);
		// A note GitLab wrote itself is not offered
		expect(screen.queryByText("changed the milestone")).not.toBeInTheDocument();

		fireEvent.click(screen.getByText("Happens on Windows"));
		expect(screen.getByText("Select Notes to Include (1/2)")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
		expect(onStartInvestigation).toHaveBeenLastCalledWith([3]);

		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		expect(screen.getByText("Select Notes to Include (2/2)")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Deselect All" }));
		fireEvent.click(screen.getAllByRole("checkbox")[1]);
		fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
		expect(onStartInvestigation).toHaveBeenLastCalledWith([3]);

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("says what the task holds when the issue has no note", async () => {
		getGitLabIssueNotes.mockResolvedValue({ success: true, data: [note(2, "system", true)] });
		renderDialog();
		expect(await screen.findByText("• No notes (this issue has no notes)")).toBeInTheDocument();
	});

	it.each([
		[{ success: false, error: "Rate limited" }, "Rate limited"],
		[{ success: false }, null],
		[{ success: true }, null],
	])("does not pass a failed read (%j) for an issue without notes", async (answer, detail) => {
		getGitLabIssueNotes.mockResolvedValue(answer);
		const { container } = renderDialog();
		expect(await screen.findByText("Failed to load notes")).toBeInTheDocument();
		if (detail) expect(screen.getByText(detail)).toBeInTheDocument();
		else expect(container.ownerDocument.querySelector(".text-destructive\\/80")).toBeNull();
		expect(screen.queryByText("• No notes (this issue has no notes)")).not.toBeInTheDocument();
	});

	it.each([
		[new Error("IPC closed"), "IPC closed"],
		["odd", null],
	])("says the notes could not be read when the call throws (%s)", async (thrown, detail) => {
		getGitLabIssueNotes.mockRejectedValue(thrown);
		renderDialog();
		expect(await screen.findByText("Failed to load notes")).toBeInTheDocument();
		if (detail) expect(screen.getByText(detail)).toBeInTheDocument();
		// No English sentence of the renderer as the detail
		expect(screen.getAllByText("Failed to load notes")).toHaveLength(1);
	});

	it("reads nothing while closed or without a project", () => {
		renderDialog({ open: false });
		renderDialog({ projectId: undefined });
		renderDialog({ selectedIssue: null });
		expect(getGitLabIssueNotes).not.toHaveBeenCalled();
	});

	it.each([
		["answers", (d: ReturnType<typeof deferred<unknown>>) => d.resolve({ success: true, data: NOTES })],
		["fails", (d: ReturnType<typeof deferred<unknown>>) => d.reject(new Error("late"))],
	])("drops a read that %s after the dialog closed", async (_label, settle) => {
		const pending = deferred<unknown>();
		getGitLabIssueNotes.mockReturnValueOnce(pending.promise);
		const { rerender, onOpenChange, onStartInvestigation, onClose } = renderDialog();
		const closed = (
			<InvestigationDialog
				open={false}
				selectedIssue={ISSUE}
				investigationStatus={IDLE}
				projectId="p1"
				onOpenChange={onOpenChange}
				onStartInvestigation={onStartInvestigation}
				onClose={onClose}
			/>
		);
		rerender(closed);
		settle(pending);
		await pending.promise.catch(() => undefined);
		rerender(closed);
		expect(screen.queryByText("Select Notes to Include (2/2)")).not.toBeInTheDocument();
		expect(screen.queryByText("Failed to load notes")).not.toBeInTheDocument();
		expect(console.error).not.toHaveBeenCalled();
	});
});

describe("InvestigationDialog (GitLab) — the run", () => {
	it.each([
		["fetching", "Reading the issue..."],
		["analyzing", "Analyzing the issue..."],
		["creating_task", "Creating the task..."],
	] as const)("shows the %s phase in words, not the main process's message", (phase, label) => {
		renderDialog({ investigationStatus: { phase, progress: 40, message: "Fetching issue details..." } });
		expect(screen.getByText(label)).toBeInTheDocument();
		expect(screen.getByText("40%")).toBeInTheDocument();
		expect(screen.queryByText("Fetching issue details...")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
		expect(getGitLabIssueNotes).toHaveBeenCalled();
	});

	it("says the task is created and closes on Done", () => {
		const { onClose } = renderDialog({
			investigationStatus: { phase: "complete", progress: 100, message: "Investigation complete" },
		});
		expect(screen.getByText("Task created! View it in your Kanban board.")).toBeInTheDocument();
		expect(screen.getByText("Task created")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(onClose).toHaveBeenCalled();
	});

	it.each([
		[{ message: "GitLab not configured", error: "GitLab not configured" }, "GitLab not configured"],
		[{ message: "Project not found" }, "Project not found"],
		[{ message: "" }, null],
	])("says the task could not be created, then why (%j), and lets the person out", async (extra, detail) => {
		const { onClose } = renderDialog({
			investigationStatus: { phase: "error", progress: 0, ...extra },
		});
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe(`The task could not be created${detail ?? ""}`);
		expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
		// The footer's Close, not the dialog's own cross (which has an icon)
		const close = screen.getAllByRole("button", { name: "Close" }).find((b) => !b.querySelector("svg"));
		if (!close) throw new Error("no Close button in the footer");
		fireEvent.click(close);
		expect(onClose).toHaveBeenCalled();
		await waitFor(() => expect(getGitLabIssueNotes).toHaveBeenCalled());
	});

	it("speaks French", async () => {
		await i18n.changeLanguage("fr");
		renderDialog({ investigationStatus: { phase: "creating_task", progress: 60, message: "Creating task from issue..." } });
		expect(screen.getByText("Création de la tâche...")).toBeInTheDocument();
	});
});
