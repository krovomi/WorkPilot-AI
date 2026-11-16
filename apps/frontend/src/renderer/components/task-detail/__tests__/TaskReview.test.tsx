/**
 * TaskReview — the review card of a task in human review: which workspace
 * view it shows (loading, freshly staged, staged earlier, worktree, none),
 * the confirmation before closing the task, the guided review that refreshes
 * the line comments when it closes, and the review comments themselves.
 *
 * The sections and dialogs are stubs that keep their props; the comments
 * come from the real `useReviewComments`, fed through `installRendererApi`.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../../../__tests__/helpers/renderer-api";
import {
	callStub,
	resetStubs,
	stubModule,
	stubProps,
} from "../../../../__tests__/helpers/stub-component";
import type { Task, WorktreeStatus } from "../../../../shared/types";
import { TaskReview } from "../TaskReview";

vi.mock("../task-review", () =>
	stubModule(
		"CompletionDialog",
		"ConflictDetailsDialog",
		"CreatePRDialog",
		"DiffViewDialog",
		"GuidedReviewDialog",
		"DiscardDialog",
		"LoadingMessage",
		"NoWorkspaceMessage",
		"QAFeedbackSection",
		"StagedInProjectMessage",
		"StagedSuccessMessage",
		"WorkspaceStatus",
	),
);
vi.mock("../PlanApprovalSection", () => stubModule("PlanApprovalSection"));
vi.mock("../TaskTestGenerator", () => stubModule("TaskTestGenerator"));

const TASK = {
	id: "t1",
	specId: "001-spec",
	projectId: "p1",
	title: "Task one",
	description: "",
	status: "human_review",
	subtasks: [],
	logs: [],
} as unknown as Task;

const WORKTREE = {
	exists: true,
	worktreePath: "/repo/one/.workpilot/worktrees/tasks/001-spec",
} as WorktreeStatus;

const COMMENT = { id: "c1", status: "open", file: "a.ts", line: 3, body: "Rename" };

type Props = Parameters<typeof TaskReview>[0];

const handlers = () => ({
	onFeedbackChange: vi.fn(),
	onReject: vi.fn(),
	onMerge: vi.fn(),
	onDiscard: vi.fn(),
	onShowDiscardDialog: vi.fn(),
	onShowDiffDialog: vi.fn(),
	onStageOnlyChange: vi.fn(),
	onShowConflictDialog: vi.fn(),
	onLoadMergePreview: vi.fn(),
	onShowPRDialog: vi.fn(),
	onCreatePR: vi.fn(async () => null),
	onComplete: vi.fn(),
	onClose: vi.fn(),
	onReviewAgain: vi.fn(),
	onRefreshDiff: vi.fn(),
});

function renderReview(overrides: Partial<Props> = {}) {
	const props: Props = {
		task: TASK,
		feedback: "",
		isSubmitting: false,
		worktreeStatus: null,
		worktreeDiff: null,
		isLoadingWorktree: false,
		isMerging: false,
		isDiscarding: false,
		showDiscardDialog: false,
		showDiffDialog: false,
		workspaceError: null,
		stageOnly: false,
		stagedSuccess: null,
		stagedProjectPath: undefined,
		suggestedCommitMessage: undefined,
		mergePreview: null,
		isLoadingPreview: false,
		showConflictDialog: false,
		showPRDialog: false,
		isCreatingPR: false,
		isCompleting: false,
		...handlers(),
		...overrides,
	};
	render(<TaskReview {...props} />);
	return props;
}

const shown = (name: string) => screen.queryByTestId(`stub-${name}`) !== null;

let api: RendererApi;

beforeEach(() => {
	api = installRendererApi({
		listReviewComments: vi.fn(async () => ({ success: true, data: [COMMENT] })),
	});
});

afterEach(() => {
	cleanup();
	api.restore();
	resetStubs();
});

describe("workspace view", () => {
	it("shows the loading message while the worktree loads", () => {
		renderReview({ isLoadingWorktree: true, worktreeStatus: WORKTREE });
		expect(shown("LoadingMessage")).toBe(true);
		expect(shown("WorkspaceStatus")).toBe(false);
	});

	it("shows only the success message right after staging", () => {
		renderReview({
			stagedSuccess: "Staged",
			suggestedCommitMessage: "feat: x",
			worktreeStatus: WORKTREE,
		});
		expect(stubProps("StagedSuccessMessage")).toMatchObject({
			stagedSuccess: "Staged",
			suggestedCommitMessage: "feat: x",
		});
		expect(shown("WorkspaceStatus")).toBe(false);
		expect(shown("StagedInProjectMessage")).toBe(false);
	});

	it("shows a task staged earlier, worktree or not, without the test generator", () => {
		const props = renderReview({
			task: { ...TASK, stagedInMainProject: true },
			worktreeStatus: WORKTREE,
			stagedProjectPath: "/repo/one",
		});
		expect(stubProps("StagedInProjectMessage")).toMatchObject({
			projectPath: "/repo/one",
			hasWorktree: true,
			onClose: props.onClose,
			onReviewAgain: props.onReviewAgain,
		});
		expect(shown("TaskTestGenerator")).toBe(false);
		cleanup();
		renderReview({ task: { ...TASK, stagedInMainProject: true } });
		expect(stubProps("StagedInProjectMessage").hasWorktree).toBe(false);
	});

	it("shows the worktree with its pull request and the test generator", () => {
		const props = renderReview({
			task: { ...TASK, metadata: { prUrl: "https://x/pr/1" } },
			worktreeStatus: WORKTREE,
		});
		expect(stubProps("WorkspaceStatus")).toMatchObject({
			taskId: "t1",
			existingPrUrl: "https://x/pr/1",
			onMerge: props.onMerge,
		});
		expect(stubProps("TaskTestGenerator")).toMatchObject({
			worktreePath: WORKTREE.worktreePath,
			onTestsWritten: props.onRefreshDiff,
		});
	});

	it("prefers the task's own pull request link", () => {
		renderReview({
			task: { ...TASK, prUrl: "https://x/pr/2", metadata: { prUrl: "https://x/pr/1" } },
			worktreeStatus: WORKTREE,
		});
		expect(stubProps("WorkspaceStatus").existingPrUrl).toBe("https://x/pr/2");
	});

	it("says there is no workspace when the worktree is gone", () => {
		renderReview({ worktreeStatus: { exists: false } as WorktreeStatus });
		expect(shown("NoWorkspaceMessage")).toBe(true);
		expect(shown("TaskTestGenerator")).toBe(false);
	});
});

describe("closing the task", () => {
	it.each([
		["WorkspaceStatus", WORKTREE],
		["NoWorkspaceMessage", null],
	] as const)("%s asks for the confirmation, which closes the task", (view, worktreeStatus) => {
		const props = renderReview({ worktreeStatus });
		expect(stubProps("CompletionDialog").open).toBe(false);
		act(() => {
			callStub(view, "onRequestComplete");
		});
		expect(stubProps("CompletionDialog").open).toBe(true);
		act(() => {
			callStub("CompletionDialog", "onConfirm");
		});
		expect(props.onComplete).toHaveBeenCalledTimes(1);
		expect(stubProps("CompletionDialog").open).toBe(false);
	});

	it("the confirmation can be dismissed without closing the task", () => {
		const props = renderReview();
		act(() => {
			callStub("NoWorkspaceMessage", "onRequestComplete");
		});
		act(() => {
			callStub("CompletionDialog", "onOpenChange", false);
		});
		expect(stubProps("CompletionDialog").open).toBe(false);
		expect(props.onComplete).not.toHaveBeenCalled();
	});
});

describe("guided review and comments", () => {
	it("reads the comments of a task with a worktree and hands them to the feedback form", async () => {
		renderReview({ worktreeStatus: WORKTREE });
		await waitFor(() =>
			expect(stubProps("QAFeedbackSection").reviewComments).toEqual([COMMENT]),
		);
		expect(api.fn("listReviewComments")).toHaveBeenCalledWith("t1");
	});

	it("reads no comment without a worktree", () => {
		renderReview();
		expect(api.fn("listReviewComments")).not.toHaveBeenCalled();
		expect(stubProps("QAFeedbackSection").reviewComments).toEqual([]);
	});

	it("opens the guided review, re-reads the comments when it closes, and hands over to the full diff", async () => {
		const props = renderReview({ worktreeStatus: WORKTREE });
		await waitFor(() => expect(api.fn("listReviewComments")).toHaveBeenCalledTimes(1));
		act(() => {
			callStub("WorkspaceStatus", "onShowGuidedReview");
		});
		expect(stubProps("GuidedReviewDialog").open).toBe(true);
		await act(async () => {
			await callStub("GuidedReviewDialog", "onOpenChange", false);
		});
		expect(stubProps("GuidedReviewDialog").open).toBe(false);
		expect(api.fn("listReviewComments")).toHaveBeenCalledTimes(2);

		act(() => {
			callStub("WorkspaceStatus", "onShowGuidedReview");
		});
		act(() => {
			callStub("GuidedReviewDialog", "onOpenChange", true);
		});
		expect(api.fn("listReviewComments")).toHaveBeenCalledTimes(2);
		act(() => {
			callStub("GuidedReviewDialog", "onShowFinalDiff");
		});
		expect(stubProps("GuidedReviewDialog").open).toBe(false);
		expect(props.onShowDiffDialog).toHaveBeenCalledWith(true);
	});

	it("adds, resolves and deletes a comment, and keeps the list when the main refuses", async () => {
		const resolved = { ...COMMENT, status: "resolved" };
		api.restore();
		api = installRendererApi({
			listReviewComments: vi.fn(async () => ({ success: true, data: [] })),
			addReviewComment: vi.fn(async () => ({ success: true, data: [COMMENT] })),
			updateReviewComment: vi
				.fn()
				.mockResolvedValueOnce({ success: true, data: [resolved] })
				.mockResolvedValueOnce({ success: false }),
		});
		renderReview({ worktreeStatus: WORKTREE });
		const comments = () =>
			stubProps("GuidedReviewDialog").reviewComments as {
				comments: unknown[];
				error: string | null;
				add: (input: unknown) => Promise<boolean>;
				update: (id: string, action: string) => Promise<boolean>;
			};
		const input = { file: "a.ts", line: 3, body: "Rename" };
		await act(async () => {
			expect(await comments().add(input)).toBe(true);
		});
		expect(api.fn("addReviewComment")).toHaveBeenCalledWith("t1", input);
		expect(comments().comments).toEqual([COMMENT]);

		await act(async () => {
			expect(await comments().update("c1", "resolve")).toBe(true);
		});
		expect(comments().comments).toEqual([resolved]);

		await act(async () => {
			expect(await comments().update("c1", "delete")).toBe(false);
		});
		expect(api.fn("updateReviewComment")).toHaveBeenLastCalledWith("t1", "c1", "delete");
		expect(comments().comments).toEqual([resolved]);
		expect(comments().error).toBe("not_writable");
	});

	it("shows no comment for a card the main cannot read, or when reading throws", async () => {
		api.restore();
		api = installRendererApi({
			listReviewComments: vi
				.fn()
				.mockResolvedValueOnce({ success: true, data: [COMMENT] })
				.mockResolvedValueOnce({ success: false, error: "server card" })
				.mockRejectedValueOnce(new Error("IPC down")),
		});
		renderReview({ worktreeStatus: WORKTREE });
		await waitFor(() =>
			expect(stubProps("QAFeedbackSection").reviewComments).toEqual([COMMENT]),
		);
		await act(async () => {
			await callStub("GuidedReviewDialog", "onOpenChange", false);
		});
		expect(stubProps("QAFeedbackSection").reviewComments).toEqual([]);
		await act(async () => {
			await callStub("GuidedReviewDialog", "onOpenChange", false);
		});
		expect(stubProps("QAFeedbackSection").reviewComments).toEqual([]);
		expect(api.fn("listReviewComments")).toHaveBeenCalledTimes(3);
	});
});

describe("dialogs", () => {
	it("passes the dialogs their state and callbacks", () => {
		const props = renderReview({
			worktreeStatus: WORKTREE,
			showDiscardDialog: true,
			showDiffDialog: true,
			showConflictDialog: true,
			showPRDialog: true,
			stageOnly: true,
		});
		expect(stubProps("DiscardDialog")).toMatchObject({ open: true, onDiscard: props.onDiscard });
		expect(stubProps("DiffViewDialog")).toMatchObject({
			open: true,
			worktreePath: WORKTREE.worktreePath,
			onRefresh: props.onRefreshDiff,
		});
		expect(stubProps("ConflictDetailsDialog")).toMatchObject({ open: true, stageOnly: true });
		expect(stubProps("CreatePRDialog")).toMatchObject({ open: true, onCreatePR: props.onCreatePR });
		expect(stubProps("PlanApprovalSection").task).toBe(props.task);
	});
});
