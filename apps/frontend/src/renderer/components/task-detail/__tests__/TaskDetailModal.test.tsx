/**
 * TaskDetailModal — the task panel: its header (status, review reason,
 * progress, TDD switch), the action that fits the task's state (start, stop,
 * recover, resume, complete), the review handlers it gives the review card,
 * the delete / abandon / formula dialogs, and the keyboard and chevron
 * navigation between tasks.
 *
 * The tabs' contents and the sub-dialogs are stubs (`stub-component.ts`) that
 * keep the props the panel gave them; `useTaskDetail` is the real hook, fed
 * through `installRendererApi`. The task store's actions are replaced so each
 * test says what the main process answered.
 */

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../../../__tests__/helpers/renderer-api";
import {
	callStub,
	resetStubs,
	stubComponent,
	stubModule,
	stubProps,
} from "../../../../__tests__/helpers/stub-component";
import i18n from "../../../../shared/i18n";
import type { Project, Subtask, Task } from "../../../../shared/types";
import { useArchitectureDeltaStore } from "../../../stores/architecture-delta-store";
import { useFormulaMatrixStore } from "../../../stores/formula-matrix-store";
import { useProjectStore } from "../../../stores/project-store";
import {
	abandonTask,
	deleteTask,
	pauseTask,
	persistTaskStatus,
	persistUpdateTask,
	recoverStuckTask,
	resumeAbandonedTask,
	resumeTask,
	startTask,
	stopTask,
	submitReview,
	updatePlanSubtasks,
	useTaskStore,
} from "../../../stores/task-store";
import { useVerifyStore } from "../../../stores/verify-store";
import { TaskDetailModal } from "../TaskDetailModal";

const toast = vi.fn();
vi.mock("../../../hooks/use-toast", () => ({
	useToast: () => ({ toast }),
	toast: (...args: unknown[]) => toast(...args),
}));

vi.mock("../../../stores/task-store", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	abandonTask: vi.fn(),
	deleteTask: vi.fn(),
	pauseTask: vi.fn(),
	persistTaskStatus: vi.fn(),
	persistUpdateTask: vi.fn(),
	recoverStuckTask: vi.fn(),
	resumeAbandonedTask: vi.fn(),
	resumeTask: vi.fn(),
	startTask: vi.fn(),
	stopTask: vi.fn(),
	submitReview: vi.fn(),
	updatePlanSubtasks: vi.fn(),
}));

// The overview shows the review card it is handed.
vi.mock("../TaskOverview", () => {
	const Overview = stubComponent("TaskOverview");
	return {
		TaskOverview: (props: Record<string, unknown>) =>
			Overview({ ...props, children: props.review as ReactNode }),
	};
});
// Two edit dialogs share a component: each keeps its own props.
vi.mock("../../TaskEditDialog", () => {
	const Edit = stubComponent("TaskEditDialog");
	const Duplicate = stubComponent("DuplicateDialog");
	return {
		TaskEditDialog: (props: Record<string, unknown>) =>
			createElement(props.mode === "duplicate" ? Duplicate : Edit, props),
	};
});
vi.mock("../TaskReview", () => stubModule("TaskReview"));
vi.mock("../TaskSubtasks", () => stubModule("TaskSubtasks"));
vi.mock("../TaskLogs", () => stubModule("TaskLogs"));
vi.mock("../TaskFiles", () => stubModule("TaskFiles"));
vi.mock("../TaskChangeGraph", () => stubModule("TaskChangeGraph"));
vi.mock("../TaskVisualProof", () => stubModule("TaskVisualProof"));
vi.mock("../TaskEmulator", () => stubModule("TaskEmulator"));
vi.mock("../TaskMobilePreview", () => stubModule("TaskMobilePreview"));
vi.mock("../TaskVerify", () => stubModule("TaskVerify"));
vi.mock("../TaskArchitectureDelta", () => stubModule("TaskArchitectureDelta"));
vi.mock("../AbandonDialog", () => stubModule("AbandonDialog"));
vi.mock("../task-review/SyncFromBranchDialog", () =>
	stubModule("SyncFromBranchDialog"),
);
vi.mock("../TaskPauseControls", () => stubModule("TaskPauseControls"));
vi.mock("../TaskRunControls", () => stubModule("TaskRunControls"));
vi.mock("../../streaming/StreamingSessionButton", () =>
	stubModule("StreamingSessionButton"),
);
vi.mock("../ContextGauge", () => stubModule("ContextGauge"));
vi.mock("../TaskWaitingBanner", () => stubModule("TaskWaitingBanner"));
vi.mock("../TaskWarnings", () => stubModule("TaskWarnings"));
vi.mock("../PlanConflictBadge", () => stubModule("PlanConflictBadge"));
vi.mock("../TaskPhaseProgressBar", () => stubModule("TaskPhaseProgressBar"));
vi.mock("../TaskStatusMoveBadge", () => stubModule("TaskStatusMoveBadge"));
vi.mock("../EditableTaskTitle", () => stubModule("EditableTaskTitle"));

const PROJECT = { id: "p1", name: "One", path: "/repo/one", settings: {} } as Project;

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		specId: "001-spec",
		projectId: "p1",
		title: "Task one",
		description: "Do it",
		status: "backlog",
		subtasks: [],
		logs: [],
		createdAt: new Date("2026-11-01T10:00:00Z"),
		updatedAt: new Date("2026-11-01T10:00:00Z"),
		...overrides,
	} as Task;
}

function subtask(id: string, status: Subtask["status"]): Subtask {
	return { id, title: `Sub ${id}`, description: "", status, files: [] } as Subtask;
}

let api: RendererApi;
const onOpenChange = vi.fn();

function renderModal(
	task: Task | null,
	props: Partial<Parameters<typeof TaskDetailModal>[0]> = {},
) {
	const ui = (current: Task | null, extra = props) => (
		<TaskDetailModal open task={current} onOpenChange={onOpenChange} {...extra} />
	);
	const view = render(ui(task));
	return {
		...view,
		rerenderWith: (next: Task | null, extra = props) => view.rerender(ui(next, extra)),
	};
}

const toastTitles = () =>
	toast.mock.calls.map(([arg]) => (arg as { title: string }).title);

const projectInitial = useProjectStore.getState();
const taskInitial = useTaskStore.getState();
const verifyInitial = useVerifyStore.getState();
const deltaInitial = useArchitectureDeltaStore.getState();
const formulaInitial = useFormulaMatrixStore.getState();

beforeEach(() => {
	api = installRendererApi({
		listReviewComments: vi.fn(async () => ({ success: true, data: [] })),
	});
	useProjectStore.setState({
		projects: [PROJECT],
		selectedProjectId: "p1",
		activeProjectId: "p1",
	});
	vi.mocked(persistTaskStatus).mockResolvedValue({ success: true });
	vi.mocked(persistUpdateTask).mockResolvedValue(true);
	vi.mocked(deleteTask).mockResolvedValue({ success: true });
	vi.mocked(abandonTask).mockResolvedValue({ success: true });
	vi.mocked(resumeAbandonedTask).mockResolvedValue({ success: true });
	vi.mocked(recoverStuckTask).mockResolvedValue({ success: true, message: "" });
	vi.mocked(updatePlanSubtasks).mockResolvedValue(true);
	vi.mocked(submitReview).mockResolvedValue(true);
});

afterEach(async () => {
	cleanup();
	api.restore();
	vi.useRealTimers();
	vi.clearAllMocks();
	resetStubs();
	localStorage.clear();
	useProjectStore.setState(projectInitial, true);
	useTaskStore.setState(taskInitial, true);
	useVerifyStore.setState(verifyInitial, true);
	useArchitectureDeltaStore.setState(deltaInitial, true);
	useFormulaMatrixStore.setState(formulaInitial, true);
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

describe("header", () => {
	it("renders nothing without a task", () => {
		const { container } = renderModal(null);
		expect(container).toBeEmptyDOMElement();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("shows the spec id, the subtask count and a title without the imported HTML", () => {
		renderModal(
			makeTask({
				title: "<div><b>Fix</b> login</div>",
				subtasks: [subtask("a", "completed"), subtask("b", "pending")],
			}),
		);
		expect(screen.getByText("001-spec")).toBeInTheDocument();
		expect(screen.getByText("1/2 subtasks")).toBeInTheDocument();
		expect(stubProps("EditableTaskTitle").displayTitle).toBe("Fix login");
		expect(stubProps("EditableTaskTitle").editable).toBe(true);
	});

	it("keeps a plain title as it is, and an HTML title with no text", () => {
		const { rerenderWith } = renderModal(makeTask({ title: "Plain < title" }));
		expect(stubProps("EditableTaskTitle").displayTitle).toBe("Plain < title");
		rerenderWith(makeTask({ title: "<br/>" }));
		expect(stubProps("EditableTaskTitle").displayTitle).toBe("<br/>");
	});

	it.each([
		["done", "success"],
		["human_review", "purple"],
		["in_progress", "info"],
		["backlog", "secondary"],
	] as const)("a %s task gets the %s status badge", (status, variant) => {
		renderModal(makeTask({ status, subtasks: [subtask("a", "completed")] }));
		expect(stubProps("TaskStatusMoveBadge").variant).toBe(variant);
	});

	it.each([
		["completed", "Completed"],
		["errors", "Has Errors"],
		["plan_review", "Approve Plan"],
		["stopped", "Stopped"],
		["qa_unverified", "QA not verified"],
		["qa_rejected", "QA Issues"],
	] as const)("a review for %s says %s", (reviewReason, text) => {
		renderModal(
			makeTask({
				status: "human_review",
				reviewReason,
				subtasks: [subtask("a", "completed")],
			}),
		);
		expect(screen.getByText(text)).toBeInTheDocument();
	});

	it("an incomplete review gets the incomplete badge", () => {
		renderModal(makeTask({ status: "human_review", subtasks: [subtask("a", "pending")] }));
		expect(stubProps("TaskStatusMoveBadge").label).toBe("Incomplete");
		expect(stubProps("TaskWarnings").isIncomplete).toBe(true);
	});

	it("shows the progress bar of a running task with its percentage", async () => {
		renderModal(
			makeTask({
				status: "in_progress",
				subtasks: [subtask("a", "completed"), subtask("b", "in_progress")],
			}),
		);
		expect(screen.getByText("50%")).toBeInTheDocument();
		expect(stubProps("TaskPhaseProgressBar").progress).toBe(50);
		await userEvent.click(screen.getByRole("tab", { name: "Logs" }));
		expect(stubProps("TaskLogs").currentActivity).toBe("Sub b");
	});

	it("shows the context gauge alone for an active task without progress", () => {
		renderModal(makeTask({ status: "ai_review" }));
		expect(screen.getByTestId("stub-ContextGauge")).toBeInTheDocument();
		expect(screen.queryByTestId("stub-TaskPhaseProgressBar")).toBeNull();
	});

	it("moves the task from its status badge, and says when it could not", async () => {
		renderModal(makeTask());
		await act(async () => {
			await callStub("TaskStatusMoveBadge", "onMove", "backlog");
		});
		expect(persistTaskStatus).not.toHaveBeenCalled();

		await act(async () => {
			await callStub("TaskStatusMoveBadge", "onMove", "queue");
		});
		expect(persistTaskStatus).toHaveBeenCalledWith("t1", "queue");
		expect(toast.mock.calls[0][0].description).toContain("Queue");

		vi.mocked(persistTaskStatus).mockResolvedValueOnce({
			success: false,
			worktreeExists: true,
		});
		await act(async () => {
			await callStub("TaskStatusMoveBadge", "onMove", "done");
		});
		expect(toast.mock.calls[1][0]).toMatchObject({ variant: "destructive" });
		expect(toast.mock.calls[1][0].description).toMatch(/active worktree/);

		vi.mocked(persistTaskStatus).mockResolvedValueOnce({ success: false, error: "disk full" });
		await act(async () => {
			await callStub("TaskStatusMoveBadge", "onMove", "done");
		});
		expect(toast.mock.calls[2][0].description).toBe("disk full");
	});
});

describe("TDD switch", () => {
	it("turns TDD on for the task and says so", async () => {
		renderModal(makeTask());
		const toggle = screen.getByRole("switch", { name: /TDD/ });
		expect(toggle).toHaveAttribute("aria-checked", "false");
		await userEvent.click(toggle);
		expect(persistUpdateTask).toHaveBeenCalledWith("t1", { metadata: { tddMode: true } });
		expect(toastTitles()[0]).toMatch(/enabled/i);
	});

	it("follows the project default, turns it off, and reports a failed save", async () => {
		useProjectStore.setState({
			projects: [{ ...PROJECT, settings: { tddMode: true } } as Project],
		});
		vi.mocked(persistUpdateTask).mockResolvedValueOnce(false);
		renderModal(makeTask());
		const toggle = screen.getByRole("switch", { name: /TDD/ });
		expect(toggle).toHaveAttribute("aria-checked", "true");
		await userEvent.click(toggle);
		expect(persistUpdateTask).toHaveBeenCalledWith("t1", { metadata: { tddMode: false } });
		expect(toast.mock.calls[0][0]).toMatchObject({ variant: "destructive" });
	});

	it("a disabled TDD override says so", async () => {
		renderModal(makeTask({ metadata: { tddMode: true } }));
		await userEvent.click(screen.getByRole("switch", { name: /TDD/ }));
		expect(persistUpdateTask).toHaveBeenCalledWith("t1", { metadata: { tddMode: false } });
		expect(toastTitles()[0]).toMatch(/disabled/i);
	});

	it("cannot be switched, nor the task edited, while it runs", () => {
		renderModal(makeTask({ status: "in_progress" }));
		expect(screen.getByRole("switch", { name: /TDD/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Edit task" })).toBeDisabled();
		expect(stubProps("EditableTaskTitle").editable).toBe(false);
	});
});

describe("primary action", () => {
	it("starts a backlog task", async () => {
		renderModal(makeTask());
		await userEvent.click(screen.getByRole("button", { name: "Start Task" }));
		expect(startTask).toHaveBeenCalledWith("t1");
		expect(toast).not.toHaveBeenCalled();
		expect(screen.getByTestId("stub-StreamingSessionButton")).toBeInTheDocument();
	});

	it("says the task will run on the project's provider, not the one it was made with", async () => {
		useProjectStore.setState({
			projects: [{ ...PROJECT, settings: { provider: "openai" } } as Project],
		});
		renderModal(makeTask({ metadata: { provider: "claude" } }));
		await userEvent.click(screen.getByRole("button", { name: "Start Task" }));
		expect(toast.mock.calls[0][0].description).toMatch(/openai.*claude/);
		expect(startTask).toHaveBeenCalledWith("t1");
	});

	it("stops a running task, and a task in AI review, from the run controls", async () => {
		const { rerenderWith } = renderModal(makeTask({ status: "in_progress" }));
		await act(async () => {
			await callStub("TaskRunControls", "onStop");
		});
		expect(stopTask).toHaveBeenCalledWith("t1");

		rerenderWith(makeTask({ status: "ai_review" }));
		await act(async () => {
			await callStub("TaskRunControls", "onStop");
		});
		expect(stopTask).toHaveBeenCalledTimes(2);
	});

	it("a paused task gets the run controls, and the pause panel resumes it", async () => {
		renderModal(
			makeTask({ status: "human_review", metadata: { paused: { enabled: true, paused_at: null, paused_subtask_id: null } } }),
		);
		expect(stubProps("TaskRunControls").isPaused).toBe(true);
		await act(async () => {
			await callStub("TaskPauseControls", "onPause", "sub-1");
			await callStub("TaskPauseControls", "onResumeSameProvider");
		});
		expect(pauseTask).toHaveBeenCalledWith("t1", "sub-1");
		expect(resumeTask).toHaveBeenCalledWith("t1");
	});

	it("an incomplete task resumes once its plan reloads, and says when it cannot", async () => {
		useProjectStore.setState({ selectedProjectId: null });
		await i18n.changeLanguage("fr");
		renderModal(makeTask({ status: "human_review" }));
		await userEvent.click(screen.getByRole("button", { name: "Reprendre la tâche" }));
		expect(toastTitles()).toEqual(["Impossible de reprendre la tâche"]);
		expect(toast.mock.calls[0][0].description).toMatch(/plan d'implémentation/);
		expect(startTask).not.toHaveBeenCalled();
	});

	it("an incomplete task whose plan is fine starts again", async () => {
		renderModal(
			makeTask({
				status: "human_review",
				subtasks: [{ ...subtask("a", "pending"), description: "Do a" }],
			}),
		);
		await userEvent.click(screen.getByRole("button", { name: "Resume Task" }));
		expect(startTask).toHaveBeenCalledWith("t1");
		await act(async () => {
			await callStub("TaskWarnings", "onResume");
		});
		expect(startTask).toHaveBeenCalledTimes(2);
	});

	it("a stuck task is recovered and restarted", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		api.restore();
		api = installRendererApi({
			checkTaskRunning: vi.fn(async () => ({ success: true, data: false })),
		});
		renderModal(makeTask({ status: "in_progress" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(stubProps("TaskStatusMoveBadge").label).toBe("Stuck");
		// A stuck task is not running: closing it warns of nothing.
		await userEvent.click(screen.getAllByRole("button", { name: "Close" })[1]);
		expect(toast).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Recover Task" }));
		expect(recoverStuckTask).toHaveBeenCalledWith("t1", { autoRestart: true });
		await waitFor(() =>
			expect(stubProps("TaskStatusMoveBadge").label).toBeUndefined(),
		);
	});

	it("a done task links to its pull request", async () => {
		renderModal(makeTask({ status: "done", metadata: { prUrl: "https://x/pr/1" } }));
		expect(screen.getByText("Complete")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(api.fn("openExternal")).toHaveBeenCalledWith("https://x/pr/1");
		// Nothing to sync from, nothing to abandon.
		expect(screen.queryByRole("button", { name: "Sync from branch" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Abandon" })).toBeNull();
	});

	it("a done task without a pull request only says it is complete", () => {
		renderModal(makeTask({ status: "done" }));
		expect(screen.getByText("Complete")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
	});

	it("a task in review has no primary action", () => {
		renderModal(
			makeTask({ status: "human_review", reviewReason: "completed", subtasks: [subtask("a", "completed")] }),
		);
		expect(screen.queryByRole("button", { name: "Start Task" })).toBeNull();
		expect(screen.queryByTestId("stub-TaskRunControls")).toBeNull();
	});
});

describe("execution formula gate", () => {
	const imported = (id = "t1") =>
		makeTask({ id, metadata: { duplicatedFrom: "t0" } });

	it("asks once for a formula before starting a duplicated task", async () => {
		renderModal(imported());
		await userEvent.click(screen.getByRole("button", { name: "Start Task" }));
		expect(startTask).not.toHaveBeenCalled();
		const gate = await screen.findByRole("alertdialog");
		await userEvent.click(within(gate).getByRole("button", { name: /defaults/i }));
		expect(startTask).toHaveBeenCalledWith("t1");

		await userEvent.click(screen.getByRole("button", { name: "Start Task" }));
		expect(startTask).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("asks again for the next task the panel moves to", async () => {
		const { rerenderWith } = renderModal(imported());
		await userEvent.click(screen.getByRole("button", { name: "Start Task" }));
		await userEvent.click(
			within(await screen.findByRole("alertdialog")).getByRole("button", {
				name: /defaults/i,
			}),
		);
		rerenderWith(imported("t2"));
		await userEvent.click(screen.getByRole("button", { name: "Start Task" }));
		expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
		expect(startTask).toHaveBeenCalledTimes(1);
	});

	it("opens the formula lab for the task", async () => {
		const openLab = vi.fn();
		useFormulaMatrixStore.setState({ openLab });
		renderModal(imported());
		await userEvent.click(screen.getByRole("button", { name: "Start Task" }));
		const gate = await screen.findByRole("alertdialog");
		const buttons = within(gate).getAllByRole("button");
		await userEvent.click(buttons[buttons.length - 1]);
		expect(openLab).toHaveBeenCalledWith({
			ticketId: "t1",
			ticketTitle: "Task one",
			description: "Do it",
			projectPath: "/repo/one",
		});
		expect(startTask).not.toHaveBeenCalled();
	});
});

describe("closing", () => {
	it("warns that a running task goes on in the background", async () => {
		renderModal(makeTask({ status: "in_progress" }));
		await userEvent.click(screen.getAllByRole("button", { name: "Close" })[1]);
		expect(toastTitles()).toEqual(["Task continues in background"]);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("closes from the header without a warning for an idle task", async () => {
		await i18n.changeLanguage("fr");
		renderModal(makeTask());
		await userEvent.click(screen.getAllByRole("button", { name: "Fermer" })[0]);
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(toast).not.toHaveBeenCalled();
	});
});

describe("delete", () => {
	it("shows why the task could not be deleted, in the app's language", async () => {
		await i18n.changeLanguage("fr");
		vi.mocked(deleteTask).mockResolvedValueOnce({ success: false });
		renderModal(makeTask());
		await userEvent.click(screen.getByRole("button", { name: "Supprimer la tâche" }));
		const dialog = await screen.findByRole("alertdialog");
		await userEvent.click(within(dialog).getByRole("button", { name: /Supprimer définitivement/ }));
		expect(await within(dialog).findByText("Échec de la suppression de la tâche")).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("closes the panel once the task is deleted", async () => {
		renderModal(makeTask());
		await userEvent.click(screen.getByRole("button", { name: "Delete Task" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText(/"Task one"/)).toBeInTheDocument();
		await userEvent.click(within(dialog).getByRole("button", { name: /Delete Permanently/ }));
		expect(deleteTask).toHaveBeenCalledWith("t1");
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});

	it("shows the main process's reason", async () => {
		vi.mocked(deleteTask).mockResolvedValueOnce({ success: false, error: "locked" });
		renderModal(makeTask());
		await userEvent.click(screen.getByRole("button", { name: "Delete Task" }));
		const dialog = await screen.findByRole("alertdialog");
		await userEvent.click(within(dialog).getByRole("button", { name: /Delete Permanently/ }));
		expect(await within(dialog).findByText("locked")).toBeInTheDocument();
	});
});

describe("abandon", () => {
	it("abandons the task with its reason and says so", async () => {
		renderModal(makeTask());
		await userEvent.click(screen.getByRole("button", { name: "Abandon" }));
		expect(stubProps("AbandonDialog").open).toBe(true);
		await act(async () => {
			await callStub("AbandonDialog", "onAbandon", "no longer needed");
		});
		expect(abandonTask).toHaveBeenCalledWith("t1", "no longer needed");
		expect(stubProps("AbandonDialog").open).toBe(false);
		expect(toast.mock.calls[0][0].variant).toBeUndefined();
	});

	it("reports a refused abandon", async () => {
		vi.mocked(abandonTask).mockResolvedValueOnce({ success: false, error: "busy" });
		renderModal(makeTask());
		await act(async () => {
			await callStub("AbandonDialog", "onAbandon");
		});
		expect(toast.mock.calls[0][0]).toMatchObject({ description: "busy", variant: "destructive" });
	});

	it("resumes an abandoned task, and reports when it cannot", async () => {
		renderModal(makeTask({ metadata: { abandoned: true } }));
		await userEvent.click(screen.getByRole("button", { name: "Resume" }));
		expect(resumeAbandonedTask).toHaveBeenCalledWith("t1");
		expect(toast).not.toHaveBeenCalled();

		vi.mocked(resumeAbandonedTask).mockResolvedValueOnce({ success: false });
		await userEvent.click(screen.getByRole("button", { name: "Resume" }));
		expect(toast.mock.calls[0][0]).toMatchObject({ variant: "destructive" });
	});
});

describe("review card", () => {
	const review = (overrides: Partial<Task> = {}) =>
		makeTask({
			status: "human_review",
			reviewReason: "completed",
			subtasks: [subtask("a", "completed")],
			...overrides,
		});

	it("sends the open line comments with a change request", async () => {
		api.restore();
		api = installRendererApi({
			listReviewComments: vi.fn(async () => ({
				success: true,
				data: [
					{ id: "c1", status: "open" },
					{ id: "c2", status: "resolved" },
				],
			})),
		});
		renderModal(review());
		await act(async () => {
			await callStub("TaskReview", "onReject");
		});
		expect(submitReview).toHaveBeenCalledWith("t1", false, "", [], ["c1"]);
	});

	it("sends nothing without feedback, images or comments, even when comments cannot be read", async () => {
		api.restore();
		api = installRendererApi({
			listReviewComments: vi.fn(async () => {
				throw new Error("gone");
			}),
		});
		renderModal(review());
		await act(async () => {
			await callStub("TaskReview", "onReject");
		});
		expect(submitReview).not.toHaveBeenCalled();

		act(() => {
			callStub("TaskReview", "onFeedbackChange", "Please rename it");
		});
		await act(async () => {
			await callStub("TaskReview", "onReject");
		});
		expect(submitReview).toHaveBeenCalledWith("t1", false, "Please rename it", [], []);
		expect(stubProps("TaskReview").feedback).toBe("");
	});

	it("merges and closes, or stages and shows the staged state", async () => {
		const mergeWorktree = vi.fn(async () => ({ success: true, data: { success: true } }));
		api.restore();
		api = installRendererApi({ mergeWorktree });
		renderModal(review());
		await act(async () => {
			await callStub("TaskReview", "onMerge");
		});
		expect(mergeWorktree).toHaveBeenCalledWith("t1", { noCommit: false });
		expect(onOpenChange).toHaveBeenCalledWith(false);

		mergeWorktree.mockResolvedValueOnce({
			success: true,
			data: { success: true, staged: true, projectPath: "/repo/one", suggestedCommitMessage: "feat: x" },
		} as never);
		act(() => {
			callStub("TaskReview", "onStageOnlyChange", true);
		});
		await act(async () => {
			await callStub("TaskReview", "onMerge");
		});
		expect(mergeWorktree).toHaveBeenLastCalledWith("t1", { noCommit: true });
		expect(stubProps("TaskReview")).toMatchObject({
			stagedSuccess: "This task's changes have been staged in your main project",
			stagedProjectPath: "/repo/one",
			suggestedCommitMessage: "feat: x",
			isMerging: false,
		});
	});

	it("shows why a merge failed, in the app's language when the main says nothing", async () => {
		await i18n.changeLanguage("fr");
		const mergeWorktree = vi.fn(async () => ({ success: false }));
		api.restore();
		api = installRendererApi({ mergeWorktree });
		renderModal(review());
		await act(async () => {
			await callStub("TaskReview", "onMerge");
		});
		expect(stubProps("TaskReview").workspaceError).toBe(
			"Échec de la fusion des modifications",
		);

		mergeWorktree.mockResolvedValueOnce({ success: true, data: { success: false, message: "conflict" } } as never);
		await act(async () => {
			await callStub("TaskReview", "onMerge");
		});
		expect(stubProps("TaskReview").workspaceError).toBe("conflict");

		mergeWorktree.mockRejectedValueOnce(new Error("IPC down"));
		await act(async () => {
			await callStub("TaskReview", "onMerge");
		});
		expect(stubProps("TaskReview").workspaceError).toBe("IPC down");

		mergeWorktree.mockRejectedValueOnce("odd");
		await act(async () => {
			await callStub("TaskReview", "onMerge");
		});
		expect(stubProps("TaskReview").workspaceError).toBe(
			"Échec de la fusion des modifications",
		);
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("discards the worktree and closes, or shows why it could not", async () => {
		await i18n.changeLanguage("fr");
		const discardWorktree = vi.fn(async () => ({ success: false }));
		api.restore();
		api = installRendererApi({ discardWorktree });
		renderModal(review());
		await act(async () => {
			await callStub("TaskReview", "onDiscard");
		});
		expect(stubProps("TaskReview").workspaceError).toBe(
			"Échec de l'abandon des modifications",
		);
		discardWorktree.mockResolvedValueOnce({ success: true, data: { success: true } } as never);
		await act(async () => {
			await callStub("TaskReview", "onDiscard");
		});
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("closes an approved task without creating a pull request", async () => {
		renderModal(review());
		await act(async () => {
			await callStub("TaskReview", "onComplete");
		});
		expect(persistTaskStatus).toHaveBeenCalledWith("t1", "done", { skipPrCreation: true });
		expect(onOpenChange).toHaveBeenCalledWith(false);

		vi.mocked(persistTaskStatus).mockResolvedValueOnce({ success: false });
		await act(async () => {
			await callStub("TaskReview", "onComplete");
		});
		expect(toast.mock.calls[0][0]).toMatchObject({ variant: "destructive" });
		expect(stubProps("TaskReview").isCompleting).toBe(false);
	});

	it("records the pull request on the task, and passes back a refusal", async () => {
		const createWorktreePR = vi.fn(async () => ({
			success: true,
			data: { success: true, prUrl: "https://x/pr/2" },
		}));
		api.restore();
		api = installRendererApi({ createWorktreePR });
		const task = review({ metadata: { tddMode: false } });
		useTaskStore.setState({ tasks: [task] });
		renderModal(task);
		let result: unknown;
		await act(async () => {
			result = await callStub("TaskReview", "onCreatePR", { draft: true });
		});
		expect(createWorktreePR).toHaveBeenCalledWith("t1", { draft: true });
		expect(result).toEqual({ success: true, prUrl: "https://x/pr/2" });
		expect(useTaskStore.getState().tasks[0]).toMatchObject({
			status: "done",
			metadata: { tddMode: false, prUrl: "https://x/pr/2" },
		});

		createWorktreePR.mockResolvedValueOnce({
			success: false,
			error: "no remote",
			data: { crossReviewBlocked: true },
		} as never);
		await act(async () => {
			result = await callStub("TaskReview", "onCreatePR", {});
		});
		expect(result).toEqual({
			success: false,
			error: "no remote",
			prUrl: undefined,
			alreadyExists: false,
			crossReviewBlocked: true,
		});

		createWorktreePR.mockRejectedValueOnce(new Error("IPC down"));
		await act(async () => {
			result = await callStub("TaskReview", "onCreatePR", {});
		});
		expect(result).toMatchObject({ success: false, error: "IPC down" });
		createWorktreePR.mockRejectedValueOnce("odd");
		await act(async () => {
			result = await callStub("TaskReview", "onCreatePR", {});
		});
		expect(result).toMatchObject({ success: false, error: undefined });
		expect(stubProps("TaskReview").isCreatingPR).toBe(false);
	});

	it("an existing pull request leaves the task where it is", async () => {
		api.restore();
		api = installRendererApi({
			createWorktreePR: vi.fn(async () => ({
				success: true,
				data: { success: true, prUrl: "https://x/pr/2", alreadyExists: true },
			})),
		});
		const task = review();
		useTaskStore.setState({ tasks: [task] });
		renderModal(task);
		await act(async () => {
			await callStub("TaskReview", "onCreatePR", {});
		});
		expect(useTaskStore.getState().tasks[0].status).toBe("human_review");
	});
});

describe("plan, tabs and dialogs", () => {
	it("saves an edited plan and says whether it worked", async () => {
		renderModal(makeTask());
		await userEvent.click(screen.getByRole("tab", { name: /Subtasks/ }));
		const phases = [{ name: "P1", subtasks: [] }];
		await act(async () => {
			await callStub("TaskSubtasks", "onUpdatePlan", phases);
		});
		expect(updatePlanSubtasks).toHaveBeenCalledWith("t1", phases);
		vi.mocked(updatePlanSubtasks).mockResolvedValueOnce(false);
		await act(async () => {
			await callStub("TaskSubtasks", "onUpdatePlan", phases);
		});
		expect(toast.mock.calls[0][0].variant).toBeUndefined();
		expect(toast.mock.calls[1][0].variant).toBe("destructive");
	});

	it("opens a tab, and the waiting banner leads back to the overview", async () => {
		renderModal(makeTask());
		await userEvent.click(screen.getByRole("tab", { name: "Logs" }));
		expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute("data-state", "active");
		act(() => {
			callStub("TaskWaitingBanner", "onShowOverview");
		});
		expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("data-state", "active");
	});

	it("hides the files tab when it is turned off", () => {
		localStorage.setItem("use_files_tab", "false");
		renderModal(makeTask());
		expect(screen.queryByRole("tab", { name: "Files" })).toBeNull();
	});

	it("shows the verification and architecture tabs only when they have something", async () => {
		const { unmount } = renderModal(makeTask());
		expect(screen.queryByRole("tab", { name: "Verification" })).toBeNull();
		expect(stubProps("TaskOverview").onOpenVerify).toBeUndefined();
		unmount();

		useVerifyStore.setState({
			load: vi.fn(async () => undefined),
			clear: vi.fn(),
			byTask: { t1: { data: { record: { status: "passed" } } } } as never,
		});
		useArchitectureDeltaStore.setState({
			load: vi.fn(async () => undefined),
			clear: vi.fn(),
			byTask: { t1: { running: true } } as never,
		});
		renderModal(makeTask({ specsPath: "/repo/one/.workpilot/specs/001-spec" }));
		const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
		expect(tabs.slice(8)).toEqual(["Verification", "Architecture"]);
		act(() => {
			callStub("TaskOverview", "onOpenVerify");
		});
		expect(screen.getAllByRole("tab")[8]).toHaveAttribute("data-state", "active");
		expect(useVerifyStore.getState().load).toHaveBeenCalledWith("t1", {
			projectDir: "/repo/one",
			specId: "001-spec",
		});
	});

	it("opens the edit, duplicate and sync dialogs", async () => {
		renderModal(makeTask());
		await userEvent.click(screen.getByRole("button", { name: "Edit task" }));
		expect(stubProps("TaskEditDialog").open).toBe(true);
		await userEvent.click(screen.getByRole("button", { name: "Duplicate" }));
		expect(stubProps("DuplicateDialog").open).toBe(true);
		act(() => {
			callStub("DuplicateDialog", "onCreated");
		});
		expect(stubProps("DuplicateDialog").open).toBe(false);
		await userEvent.click(screen.getByRole("button", { name: "Sync from branch" }));
		expect(stubProps("SyncFromBranchDialog")).toMatchObject({ open: true, projectPath: "/repo/one" });
		act(() => {
			callStub("TaskEditDialog", "onCloseTask");
		});
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("maximizes the panel and restores it", async () => {
		renderModal(makeTask());
		await userEvent.click(screen.getByRole("button", { name: "Fullscreen" }));
		expect(screen.getByRole("dialog").className).toContain("w-screen");
		await userEvent.click(screen.getByRole("button", { name: "Restore" }));
		expect(screen.getByRole("dialog").className).not.toContain("w-screen");
	});
});

describe("navigation between tasks", () => {
	const nav = () => ({
		onNavigatePrevious: vi.fn(),
		onNavigateNext: vi.fn(),
		hasPrevious: true,
		hasNext: true,
	});

	it("moves with the arrow keys", () => {
		const props = nav();
		renderModal(makeTask(), props);
		fireEvent.keyDown(window, { key: "ArrowRight" });
		fireEvent.keyDown(window, { key: "ArrowLeft" });
		expect(props.onNavigateNext).toHaveBeenCalledTimes(1);
		expect(props.onNavigatePrevious).toHaveBeenCalledTimes(1);
	});

	it("leaves the keys alone with a modifier, in a field, or with a dialog open", async () => {
		const props = nav();
		renderModal(makeTask(), props);
		fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true });
		fireEvent.keyDown(window, { key: "Enter" });
		const field = document.createElement("input");
		document.body.appendChild(field);
		fireEvent.keyDown(field, { key: "ArrowRight" });
		const editable = document.createElement("div");
		editable.contentEditable = "true";
		Object.defineProperty(editable, "isContentEditable", { value: true });
		document.body.appendChild(editable);
		fireEvent.keyDown(editable, { key: "ArrowLeft" });
		await userEvent.click(screen.getByRole("button", { name: "Edit task" }));
		fireEvent.keyDown(window, { key: "ArrowRight" });
		expect(props.onNavigateNext).not.toHaveBeenCalled();
		expect(props.onNavigatePrevious).not.toHaveBeenCalled();
		field.remove();
		editable.remove();
	});

	// The chevrons sit outside the dialog's content, which hides them from the
	// accessibility tree: they are found by their marker.
	const chevron = (which: "previous" | "next") =>
		document.querySelector(`[data-task-nav="${which}"]`) as HTMLButtonElement;

	it("does nothing at the ends, or when the panel is closed", () => {
		const props = { ...nav(), hasPrevious: false, hasNext: false };
		const { rerenderWith } = renderModal(makeTask(), props);
		fireEvent.keyDown(window, { key: "ArrowRight" });
		fireEvent.keyDown(window, { key: "ArrowLeft" });
		expect(chevron("next")).toBeDisabled();
		expect(chevron("next")).toHaveAttribute("aria-label", "Next task");
		rerenderWith(makeTask(), { ...props, hasNext: true, open: false });
		fireEvent.keyDown(window, { key: "ArrowRight" });
		expect(props.onNavigateNext).not.toHaveBeenCalled();
		expect(props.onNavigatePrevious).not.toHaveBeenCalled();
	});

	it("the chevrons move without closing the panel, a click elsewhere closes it", async () => {
		const props = nav();
		renderModal(makeTask(), props);
		// The dialog listens for outside presses from the next tick on, and acts
		// on the click that follows the press.
		await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
		fireEvent.pointerDown(chevron("next"));
		fireEvent.click(chevron("next"));
		fireEvent.pointerDown(chevron("previous"));
		fireEvent.click(chevron("previous"));
		expect(props.onNavigateNext).toHaveBeenCalledTimes(1);
		expect(props.onNavigatePrevious).toHaveBeenCalledTimes(1);
		expect(onOpenChange).not.toHaveBeenCalled();
		fireEvent.pointerDown(document.body);
		fireEvent.click(document.body);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("has no chevrons and no key handler without navigation", () => {
		renderModal(makeTask());
		fireEvent.keyDown(window, { key: "ArrowRight" });
		expect(chevron("next")).toBeNull();
	});
});
