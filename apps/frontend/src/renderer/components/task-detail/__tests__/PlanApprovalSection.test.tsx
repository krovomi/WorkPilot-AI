/**
 * PlanApprovalSection — a plan waiting for approval: approve it and start
 * coding, or ask for changes with a reason; the other active tasks whose plan
 * touches the same files, which can be made prerequisites; and the reset that
 * sends the task back to the backlog.
 */

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../../../__tests__/helpers/renderer-api";
import i18n from "../../../../shared/i18n";
import type { PlanConflictReport, Task } from "../../../../shared/types";
import {
	persistUpdateTask,
	resetTask,
	startTask,
	submitReview,
	useTaskStore,
} from "../../../stores/task-store";
import { PlanApprovalSection } from "../PlanApprovalSection";
import { PlanConflictAlert } from "../PlanConflictAlert";
import { TaskResetButton } from "../TaskResetButton";

const toast = vi.fn();
vi.mock("../../../hooks/use-toast", () => ({
	useToast: () => ({ toast }),
	toast: (...args: unknown[]) => toast(...args),
}));
vi.mock("../../../stores/task-store", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	persistUpdateTask: vi.fn(),
	resetTask: vi.fn(),
	startTask: vi.fn(),
	submitReview: vi.fn(),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		specId: "001",
		projectId: "p1",
		title: "Task one",
		description: "",
		status: "human_review",
		reviewReason: "plan_review",
		subtasks: [],
		logs: [],
		...overrides,
	} as Task;
}

function report(
	conflictingTasks: PlanConflictReport["conflictingTasks"] = [],
): PlanConflictReport {
	return {
		taskId: "t1",
		conflictingTasks,
		totalConflictingFiles: conflictingTasks.reduce((n, c) => n + c.files.length, 0),
		checkedAt: "2026-11-15T10:00:00Z",
	} as PlanConflictReport;
}

let api: RendererApi;

function install(result: unknown) {
	api.restore();
	api = installRendererApi({
		checkPlanConflicts: vi.fn(async () => result),
	});
}

const taskInitial = useTaskStore.getState();

beforeEach(() => {
	api = installRendererApi({
		checkPlanConflicts: vi.fn(async () => ({ success: true, data: report() })),
	});
	vi.mocked(submitReview).mockResolvedValue(true);
	vi.mocked(persistUpdateTask).mockResolvedValue(true);
	vi.mocked(resetTask).mockResolvedValue({ success: true });
});

afterEach(async () => {
	cleanup();
	api.restore();
	vi.clearAllMocks();
	useTaskStore.setState(taskInitial, true);
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

describe("PlanApprovalSection", () => {
	it("shows nothing unless the plan waits for approval", () => {
		const { container } = render(
			<PlanApprovalSection task={makeTask({ reviewReason: "completed" })} />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("approves the plan and starts coding", async () => {
		const onApproved = vi.fn();
		render(<PlanApprovalSection task={makeTask()} onApproved={onApproved} />);
		expect(await screen.findByText("No file overlap with other active tasks")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Approve Plan" }));
		expect(submitReview).toHaveBeenCalledWith("t1", true);
		expect(onApproved).toHaveBeenCalled();
		expect(startTask).toHaveBeenCalledWith("t1");
	});

	it("starts nothing when the approval is refused or fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.mocked(submitReview).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("IPC"));
		render(<PlanApprovalSection task={makeTask()} />);
		const approve = screen.getByRole("button", { name: "Approve Plan" });
		await userEvent.click(approve);
		await userEvent.click(approve);
		expect(startTask).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalled();
		expect(approve).toBeEnabled();
		error.mockRestore();
	});

	it("asks for the reason before sending a change request", async () => {
		const onRejected = vi.fn();
		render(<PlanApprovalSection task={makeTask()} onRejected={onRejected} />);
		await userEvent.click(screen.getByRole("button", { name: "Request Changes" }));
		expect(submitReview).not.toHaveBeenCalled();
		await userEvent.type(
			screen.getByLabelText("Reason for changes (optional)"),
			"Split the second phase",
		);
		await userEvent.click(screen.getByRole("button", { name: "Send the request" }));
		expect(submitReview).toHaveBeenCalledWith("t1", false, "Split the second phase");
		expect(onRejected).toHaveBeenCalled();
		expect(screen.queryByLabelText("Reason for changes (optional)")).toBeNull();
	});

	it("sends a change request without a reason, keeps it on a refusal, and can be cancelled", async () => {
		await i18n.changeLanguage("fr");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.mocked(submitReview).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("IPC"));
		render(<PlanApprovalSection task={makeTask()} />);
		await userEvent.click(screen.getByRole("button", { name: "Demander des modifications" }));
		await userEvent.click(screen.getByRole("button", { name: "Envoyer la demande" }));
		expect(submitReview).toHaveBeenCalledWith("t1", false, undefined);
		expect(screen.getByLabelText("Raison des modifications (optionnel)")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Envoyer la demande" }));
		expect(error).toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Annuler" }));
		expect(screen.queryByLabelText("Raison des modifications (optionnel)")).toBeNull();
		error.mockRestore();
	});

	it("is disabled while a review is being submitted", () => {
		render(<PlanApprovalSection task={makeTask()} isSubmitting />);
		expect(screen.getByRole("button", { name: "Approve Plan" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Request Changes" })).toBeDisabled();
	});
});

describe("PlanConflictAlert", () => {
	const rival = {
		taskId: "t2",
		taskTitle: "Task two",
		taskStatus: "in_progress" as const,
		files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts"],
	};

	it("names the tasks that touch the same files, and makes one a prerequisite", async () => {
		install({ success: true, data: report([rival]) });
		render(<PlanConflictAlert task={makeTask()} />);
		expect(await screen.findByText("Task two")).toBeInTheDocument();
		expect(screen.getByText("In Progress")).toBeInTheDocument();
		expect(screen.getByText(/8 file\(s\) in this plan/)).toBeInTheDocument();
		expect(screen.getByText("f.ts")).toBeInTheDocument();
		expect(screen.queryByText("g.ts")).toBeNull();
		expect(screen.getByText("+2 more file(s)")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Depend on this one" }));
		expect(persistUpdateTask).toHaveBeenCalledWith("t1", { metadata: { blockedBy: ["t2"] } });
		expect(toast.mock.calls[0][0].title).toBe("Prerequisite added: “Task two”");
	});

	it("says when the prerequisite could not be saved", async () => {
		vi.mocked(persistUpdateTask).mockResolvedValueOnce(false);
		install({ success: true, data: report([{ ...rival, files: ["a.ts"] }]) });
		render(<PlanConflictAlert task={makeTask({ metadata: { blockedBy: ["t9"] } })} />);
		await userEvent.click(await screen.findByRole("button", { name: "Depend on this one" }));
		expect(persistUpdateTask).toHaveBeenCalledWith("t1", { metadata: { blockedBy: ["t9", "t2"] } });
		expect(toast.mock.calls[0][0].variant).toBe("destructive");
	});

	it("offers no dependency that exists already or would make a cycle", async () => {
		useTaskStore.setState({
			tasks: [makeTask({ id: "t3", metadata: { blockedBy: ["t1"] } })],
		});
		install({
			success: true,
			data: report([rival, { ...rival, taskId: "t3", taskTitle: "Task three" }]),
		});
		render(<PlanConflictAlert task={makeTask({ metadata: { blockedBy: ["t2"] } })} />);
		expect(await screen.findByText("Already a prerequisite")).toBeInTheDocument();
		expect(screen.getByText("Not possible: would create a cycle")).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("shows nothing when the check fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		install({ success: false });
		const { container, unmount } = render(<PlanConflictAlert task={makeTask()} />);
		expect(screen.getByText(/Checking for file overlaps/)).toBeInTheDocument();
		await waitFor(() => expect(container).toBeEmptyDOMElement());
		unmount();
		api.restore();
		api = installRendererApi({
			checkPlanConflicts: vi.fn(async () => {
				throw new Error("IPC down");
			}),
		});
		const second = render(<PlanConflictAlert task={makeTask()} />);
		await waitFor(() => expect(second.container).toBeEmptyDOMElement());
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});

	it("drops a late answer for a task it no longer shows", async () => {
		let answer: (value: unknown) => void = () => undefined;
		api.restore();
		api = installRendererApi({
			checkPlanConflicts: vi.fn(() => new Promise((resolve) => {
				answer = resolve;
			})),
		});
		const { unmount } = render(<PlanConflictAlert task={makeTask()} />);
		unmount();
		await act(async () => answer({ success: true, data: report([rival]) }));
		expect(screen.queryByText("Task two")).toBeNull();
	});
});

describe("TaskResetButton", () => {
	it("is only offered once the pipeline produced something", () => {
		const { container } = render(<TaskResetButton task={makeTask({ status: "in_progress" })} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("resets the task after confirmation", async () => {
		const onReset = vi.fn();
		render(<TaskResetButton task={makeTask({ status: "done" })} onReset={onReset} />);
		await userEvent.click(screen.getByRole("button", { name: "Reset task" }));
		const dialog = screen.getByRole("alertdialog");
		await userEvent.click(within(dialog).getByRole("button", { name: "Reset everything" }));
		expect(resetTask).toHaveBeenCalledWith("t1");
		expect(onReset).toHaveBeenCalled();
		expect(toast.mock.calls[0][0].title).toBe("Task reset");
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	});

	it("keeps the dialog open and says why the reset failed", async () => {
		vi.mocked(resetTask)
			.mockResolvedValueOnce({ success: false, error: "worktree busy" })
			.mockResolvedValueOnce({ success: false });
		render(<TaskResetButton task={makeTask({ status: "error" })} />);
		await userEvent.click(screen.getByRole("button", { name: "Reset task" }));
		const confirm = within(screen.getByRole("alertdialog")).getByRole("button", {
			name: "Reset everything",
		});
		await userEvent.click(confirm);
		expect(toast.mock.calls[0][0]).toMatchObject({ description: "worktree busy", variant: "destructive" });
		await userEvent.click(confirm);
		expect(toast.mock.calls[1][0].description).toMatch(/Could not reset/);
		expect(screen.getByRole("alertdialog")).toBeInTheDocument();
	});
});
