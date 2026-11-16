/**
 * The review card's messages when there is no worktree to review: loading,
 * no workspace (or the pull request instead), a plan waiting for approval,
 * and changes already staged in the project, with the way out of each.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../../../../__tests__/helpers/renderer-api";
import i18n from "../../../../../shared/i18n";
import type { Task } from "../../../../../shared/types";
import { persistTaskStatus, startTask } from "../../../../stores/task-store";
import {
	LoadingMessage,
	NoWorkspaceMessage,
	StagedInProjectMessage,
} from "../WorkspaceMessages";

vi.mock("../../../../stores/task-store", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	persistTaskStatus: vi.fn(),
	startTask: vi.fn(),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		specId: "001-spec",
		projectId: "p1",
		title: "Task one",
		description: "",
		status: "human_review",
		reviewReason: "completed",
		subtasks: [],
		logs: [],
		...overrides,
	} as Task;
}

const PR = {
	number: 42,
	title: "Add login",
	url: "https://github.com/o/r/pull/42",
	changed_files: 3,
	additions: 10,
	deletions: 2,
	source_branch: "workpilot/001-spec",
	target_branch: "develop",
	state: "open",
	mergeable: true,
};

let api: RendererApi;

beforeEach(() => {
	api = installRendererApi();
	vi.mocked(persistTaskStatus).mockResolvedValue({ success: true });
});

afterEach(async () => {
	cleanup();
	api.restore();
	vi.clearAllMocks();
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

describe("LoadingMessage", () => {
	it("says the workspace is loading, in the app's language", async () => {
		await i18n.changeLanguage("fr");
		render(<LoadingMessage />);
		expect(screen.getByText("Chargement de l'espace de travail...")).toBeInTheDocument();
	});
});

describe("NoWorkspaceMessage", () => {
	it("says there is no workspace and marks the task done", async () => {
		const onClose = vi.fn();
		render(<NoWorkspaceMessage task={makeTask()} onClose={onClose} />);
		expect(screen.getByText("No Workspace Found")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Mark as Done" }));
		expect(persistTaskStatus).toHaveBeenCalledWith("t1", "done");
		expect(onClose).toHaveBeenCalled();
	});

	it("keeps the panel open when the task could not be marked done", async () => {
		vi.mocked(persistTaskStatus).mockResolvedValueOnce({ success: false, error: "locked" });
		const onClose = vi.fn();
		render(<NoWorkspaceMessage task={makeTask()} onClose={onClose} />);
		await userEvent.click(screen.getByRole("button", { name: "Mark as Done" }));
		expect(persistTaskStatus).toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Mark as Done" })).toBeEnabled();
	});

	it("survives a thrown status update", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.mocked(persistTaskStatus).mockRejectedValueOnce(new Error("IPC down"));
		const onClose = vi.fn();
		render(<NoWorkspaceMessage task={makeTask()} onClose={onClose} />);
		await userEvent.click(screen.getByRole("button", { name: "Mark as Done" }));
		expect(onClose).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});

	it("goes through the confirmation the parent wired, and shows it is busy", async () => {
		const onRequestComplete = vi.fn();
		const { rerender } = render(
			<NoWorkspaceMessage task={makeTask()} onRequestComplete={onRequestComplete} />,
		);
		await userEvent.click(screen.getByRole("button", { name: "Mark as Done" }));
		expect(onRequestComplete).toHaveBeenCalled();
		expect(persistTaskStatus).not.toHaveBeenCalled();
		rerender(
			<NoWorkspaceMessage task={makeTask()} onRequestComplete={onRequestComplete} isCompleting />,
		);
		expect(screen.getByRole("button", { name: "Updating..." })).toBeDisabled();
	});

	it("offers no action outside human review, nor without a task", () => {
		render(<NoWorkspaceMessage task={makeTask({ status: "done" })} />);
		expect(screen.queryByRole("button")).toBeNull();
		cleanup();
		render(<NoWorkspaceMessage />);
		expect(screen.getByText("No Workspace Found")).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("a plan waiting for approval proceeds to coding", async () => {
		render(<NoWorkspaceMessage task={makeTask({ reviewReason: "plan_review" })} />);
		expect(screen.getByText("Human Review Required")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Proceed to Coding" }));
		expect(startTask).toHaveBeenCalledWith("t1");
		expect(screen.getByRole("button", { name: "Proceed to Coding" })).toBeEnabled();
	});

	it("a failing start leaves the button usable", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.mocked(startTask).mockImplementationOnce(() => {
			throw new Error("no agent");
		});
		render(<NoWorkspaceMessage task={makeTask({ reviewReason: "plan_review" })} />);
		await userEvent.click(screen.getByRole("button", { name: "Proceed to Coding" }));
		expect(error).toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Proceed to Coding" })).toBeEnabled();
		error.mockRestore();
	});

	it("shows the pull request instead, then marks the task done from it", async () => {
		const getPRDetails = vi.fn(async () => ({ success: true, data: { data: PR } }));
		api.restore();
		api = installRendererApi({ getPRDetails });
		const onRequestComplete = vi.fn();
		render(
			<NoWorkspaceMessage
				task={makeTask({ metadata: { prUrl: PR.url } })}
				onRequestComplete={onRequestComplete}
			/>,
		);
		expect(screen.getByText("Loading PR information...")).toBeInTheDocument();
		expect(await screen.findByText("workpilot/001-spec")).toBeInTheDocument();
		expect(getPRDetails).toHaveBeenCalledWith(42, "t1");
		await userEvent.click(screen.getByRole("button", { name: "Mark as Done" }));
		expect(onRequestComplete).toHaveBeenCalled();
	});

	it("the pull request of a finished task, or of an Azure DevOps link, has no action", async () => {
		const getPRDetails = vi.fn(async () => ({ success: true, data: { data: PR } }));
		api.restore();
		api = installRendererApi({ getPRDetails });
		render(
			<NoWorkspaceMessage
				task={makeTask({
					status: "done",
					metadata: { prUrl: "https://dev.azure.com/o/p/_git/r/pullrequest/77" },
				})}
				isCompleting
			/>,
		);
		expect(await screen.findByText("workpilot/001-spec")).toBeInTheDocument();
		expect(getPRDetails).toHaveBeenCalledWith(77, "t1");
		expect(screen.queryByRole("button", { name: "Mark as Done" })).toBeNull();
	});

	it("falls back to the no-workspace message when the pull request cannot be read", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const getPRDetails = vi
			.fn()
			.mockResolvedValueOnce({ success: false, error: "gh missing" })
			.mockRejectedValueOnce(new Error("IPC down"))
			.mockResolvedValueOnce({ success: true, data: { error: "404" } });
		api.restore();
		api = installRendererApi({ getPRDetails });
		const task = (n: number) => makeTask({ metadata: { prUrl: `https://github.com/o/r/pull/${n}` } });
		const { rerender } = render(<NoWorkspaceMessage task={task(1)} />);
		expect(await screen.findByText("No Workspace Found")).toBeInTheDocument();
		rerender(<NoWorkspaceMessage task={task(2)} />);
		await waitFor(() => expect(getPRDetails).toHaveBeenCalledTimes(2));
		expect(await screen.findByText("No Workspace Found")).toBeInTheDocument();
		rerender(<NoWorkspaceMessage task={task(3)} />);
		await waitFor(() => expect(getPRDetails).toHaveBeenCalledTimes(3));
		expect(await screen.findByText("No Workspace Found")).toBeInTheDocument();
		// A link that names no pull request is not looked up.
		rerender(<NoWorkspaceMessage task={makeTask({ metadata: { prUrl: "https://github.com/o/r" } })} />);
		expect(await screen.findByText("No Workspace Found")).toBeInTheDocument();
		expect(getPRDetails).toHaveBeenCalledTimes(3);
		error.mockRestore();
	});
});

describe("StagedInProjectMessage", () => {
	const staged = makeTask({ stagedInMainProject: true, stagedAt: "2026-11-02T10:00:00Z" });

	it("says when the changes were staged and what to do next", async () => {
		await i18n.changeLanguage("fr");
		render(<StagedInProjectMessage task={staged} />);
		expect(screen.getByText(/02\/11\/2026/)).toBeInTheDocument();
		expect(screen.getByText("git diff --staged")).toBeInTheDocument();
		expect(screen.queryByText(/Supprimer le worktree/)).toBeNull();
	});

	it("without a worktree, marks the task done without a pull request", async () => {
		const onClose = vi.fn();
		render(<StagedInProjectMessage task={makeTask()} onClose={onClose} />);
		await userEvent.click(screen.getByRole("button", { name: "Mark as Done" }));
		expect(persistTaskStatus).toHaveBeenCalledWith("t1", "done", { skipPrCreation: true });
		expect(onClose).toHaveBeenCalled();
	});

	it("keeps the panel open and says why when the task could not be marked done", async () => {
		await i18n.changeLanguage("fr");
		vi.mocked(persistTaskStatus)
			.mockResolvedValueOnce({ success: false })
			.mockResolvedValueOnce({ success: false, error: "locked" })
			.mockRejectedValueOnce(new Error("IPC down"))
			.mockRejectedValueOnce("odd");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const onClose = vi.fn();
		render(<StagedInProjectMessage task={staged} onClose={onClose} />);
		const button = () => screen.getByRole("button", { name: "Marquer comme terminée" });
		await userEvent.click(button());
		expect(await screen.findByText("Impossible de marquer la tâche comme terminée")).toBeInTheDocument();
		await userEvent.click(button());
		expect(await screen.findByText("locked")).toBeInTheDocument();
		await userEvent.click(button());
		expect(await screen.findByText("IPC down")).toBeInTheDocument();
		await userEvent.click(button());
		expect(await screen.findByText("Impossible de marquer la tâche comme terminée")).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
		error.mockRestore();
	});

	it("deletes the worktree, then marks the task done", async () => {
		const discardWorktree = vi.fn(async () => ({ success: true }));
		api.restore();
		api = installRendererApi({ discardWorktree });
		const onClose = vi.fn();
		render(<StagedInProjectMessage task={staged} hasWorktree onClose={onClose} />);
		expect(screen.getByText(/keeps it for reference/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Delete Worktree & Mark Done" }));
		expect(discardWorktree).toHaveBeenCalledWith("t1", true);
		expect(persistTaskStatus).toHaveBeenCalledWith("t1", "done");
		expect(onClose).toHaveBeenCalled();
	});

	it("says what went wrong while deleting the worktree, in the app's language", async () => {
		await i18n.changeLanguage("fr");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const discardWorktree = vi
			.fn()
			.mockResolvedValueOnce({ success: false })
			.mockResolvedValueOnce({ success: true })
			.mockRejectedValueOnce("odd")
			.mockRejectedValueOnce(new Error("IPC down"));
		vi.mocked(persistTaskStatus).mockResolvedValueOnce({ success: false });
		api.restore();
		api = installRendererApi({ discardWorktree });
		const onClose = vi.fn();
		render(<StagedInProjectMessage task={staged} hasWorktree onClose={onClose} />);
		const button = () => screen.getByRole("button", { name: "Supprimer le worktree et terminer" });
		await userEvent.click(button());
		expect(await screen.findByText("Échec de la suppression du worktree")).toBeInTheDocument();
		await userEvent.click(button());
		expect(
			await screen.findByText(
				"Worktree supprimé, mais le statut de la tâche n'a pas pu être mis à jour : Une erreur inconnue s'est produite",
			),
		).toBeInTheDocument();
		await userEvent.click(button());
		expect(await screen.findByText("Échec de la suppression du worktree")).toBeInTheDocument();
		await userEvent.click(button());
		expect(await screen.findByText("IPC down")).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
		error.mockRestore();
	});

	it("keeps the worktree and only marks the task done", async () => {
		const onClose = vi.fn();
		render(<StagedInProjectMessage task={staged} hasWorktree onClose={onClose} />);
		await userEvent.click(screen.getByRole("button", { name: "Mark Done Only" }));
		expect(persistTaskStatus).toHaveBeenCalledWith("t1", "done", { skipPrCreation: true });
		expect(api.fn("discardWorktree")).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});

	it("puts the task back in review once the staged state is cleared", async () => {
		const clearStagedState = vi.fn(async () => ({ success: true }));
		api.restore();
		api = installRendererApi({ clearStagedState });
		const onReviewAgain = vi.fn();
		render(<StagedInProjectMessage task={staged} hasWorktree onReviewAgain={onReviewAgain} />);
		await userEvent.click(screen.getByRole("button", { name: "Review Again" }));
		expect(clearStagedState).toHaveBeenCalledWith("t1");
		expect(onReviewAgain).toHaveBeenCalled();
	});

	it("says why the staged state could not be cleared", async () => {
		await i18n.changeLanguage("fr");
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const clearStagedState = vi
			.fn()
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("IPC down"))
			.mockRejectedValueOnce("odd");
		api.restore();
		api = installRendererApi({ clearStagedState });
		const onReviewAgain = vi.fn();
		render(<StagedInProjectMessage task={staged} hasWorktree onReviewAgain={onReviewAgain} />);
		const button = () => screen.getByRole("button", { name: "Relire de nouveau" });
		await userEvent.click(button());
		expect(await screen.findByText("Impossible de réinitialiser l'état indexé")).toBeInTheDocument();
		await userEvent.click(button());
		expect(await screen.findByText("IPC down")).toBeInTheDocument();
		await userEvent.click(button());
		expect(await screen.findByText("Impossible de réinitialiser l'état indexé")).toBeInTheDocument();
		expect(onReviewAgain).not.toHaveBeenCalled();
		error.mockRestore();
	});

	it("offers no review again without a callback", async () => {
		render(<StagedInProjectMessage task={staged} hasWorktree />);
		expect(screen.queryByRole("button", { name: "Review Again" })).toBeNull();
		await act(async () => undefined);
	});
});
