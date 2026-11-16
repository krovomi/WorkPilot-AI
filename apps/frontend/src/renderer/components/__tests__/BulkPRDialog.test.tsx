/**
 * Creating the PRs of several tasks at once: options, progress, results.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";
import { useTaskStore } from "../../stores/task-store";
import { BulkPRDialog } from "../BulkPRDialog";

const api = {
	createWorktreePR: vi.fn(),
	openExternal: vi.fn(),
};

const task = (id: string, title: string): Task =>
	({ id, title, status: "human_review", metadata: { category: "feature" } }) as unknown as Task;

const TASKS = [task("t1", "Add login"), task("t2", "Fix cart"), task("t3", "Docs")];

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function Harness({
	tasks = TASKS,
	onComplete,
	onOpenChange,
}: {
	tasks?: Task[];
	onComplete?: () => void;
	onOpenChange?: (open: boolean) => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				open
			</button>
			<BulkPRDialog
				open={open}
				tasks={tasks}
				onOpenChange={(next) => {
					onOpenChange?.(next);
					setOpen(next);
				}}
				onComplete={onComplete}
			/>
		</>
	);
}

async function openDialog(props: Parameters<typeof Harness>[0] = {}) {
	render(<Harness {...props} />);
	await userEvent.click(screen.getByRole("button", { name: "open" }));
}

const created = (prUrl: string, extra = {}) => ({
	success: true,
	data: { success: true, prUrl, ...extra },
});

describe("BulkPRDialog", () => {
	const updateTask = vi.fn();

	beforeEach(() => {
		vi.resetAllMocks();
		Object.assign(globalThis.electronAPI, api);
		useTaskStore.setState({ updateTask } as never);
	});

	it("lists the tasks and creates their PRs with the common options", async () => {
		api.createWorktreePR.mockResolvedValue(created("https://git/pr/1"));
		const onComplete = vi.fn();
		await openDialog({ onComplete });

		expect(screen.getByText("Create pull requests for 3 selected tasks")).toBeInTheDocument();
		expect(screen.getByText("Fix cart")).toBeInTheDocument();

		await userEvent.type(screen.getByLabelText("Target branch"), "develop");
		await userEvent.click(screen.getByRole("checkbox", { name: "Create as draft PR" }));
		await userEvent.click(screen.getByRole("button", { name: "Create 3 PRs" }));

		expect(await screen.findByText("3 succeeded, 0 failed")).toBeInTheDocument();
		expect(api.createWorktreePR).toHaveBeenCalledTimes(3);
		expect(api.createWorktreePR).toHaveBeenNthCalledWith(1, "t1", {
			targetBranch: "develop",
			draft: true,
		});
		expect(updateTask).toHaveBeenCalledWith("t1", {
			status: "done",
			metadata: { category: "feature", prUrl: "https://git/pr/1" },
		});

		await userEvent.click(screen.getAllByRole("button", { name: /Pull request created successfully!/ })[0]);
		expect(api.openExternal).toHaveBeenCalledWith("https://git/pr/1");

		// The footer button comes before the X of the dialog.
		await userEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it("uses each task's default branch when none is given", async () => {
		api.createWorktreePR.mockResolvedValue(created("u"));
		await openDialog({ tasks: [TASKS[0]] });

		await userEvent.click(screen.getByRole("button", { name: "Create 1 PRs" }));

		await screen.findByText("1 succeeded, 0 failed");
		expect(api.createWorktreePR).toHaveBeenCalledWith("t1", {
			targetBranch: undefined,
			draft: false,
		});
	});

	it("refuses a branch name with invalid characters and says why", async () => {
		await openDialog();

		await userEvent.type(screen.getByLabelText("Target branch"), "feat branch");

		expect(screen.getByLabelText("Target branch")).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByText(/Branch name contains invalid characters/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Create 3 PRs" })).toBeDisabled();
	});

	it("cannot start without a task", async () => {
		await openDialog({ tasks: [] });
		expect(screen.getByRole("button", { name: "Create 0 PRs" })).toBeDisabled();
	});

	it("shows the progress of each PR", async () => {
		const first = deferred<unknown>();
		api.createWorktreePR.mockReturnValueOnce(first.promise).mockResolvedValue(created("u"));
		await openDialog();

		await userEvent.click(screen.getByRole("button", { name: "Create 3 PRs" }));

		expect(screen.getByText("Creating PR 1 of 3...")).toBeInTheDocument();
		expect(screen.getByText("Creating PR 1 of 3")).toBeInTheDocument();
		expect(screen.getByText(/0 \/ 3/)).toBeInTheDocument();

		await act(async () => first.resolve(created("u")));
		await screen.findByText("3 succeeded, 0 failed");
	});

	it("tells apart a PR that existed, a task without worktree and a failure", async () => {
		api.createWorktreePR
			.mockResolvedValueOnce(created("https://git/pr/9", { alreadyExists: true }))
			.mockResolvedValueOnce({ success: false, error: "Worktree not found for task" })
			.mockResolvedValueOnce({ success: true, data: { success: false, error: "gh: rate limited" } });
		await openDialog();

		await userEvent.click(screen.getByRole("button", { name: "Create 3 PRs" }));

		expect(await screen.findByText("1 succeeded, 1 skipped, 1 failed")).toBeInTheDocument();
		expect(screen.getByText("A pull request already exists for this branch")).toBeInTheDocument();
		expect(screen.getByText("No worktree found for this task")).toBeInTheDocument();
		expect(screen.getByText("gh: rate limited")).toBeInTheDocument();
		// A PR that already existed changes nothing on the board.
		expect(updateTask).not.toHaveBeenCalled();
	});

	it("names an unknown error when the reply carries none", async () => {
		api.createWorktreePR
			.mockResolvedValueOnce({ success: false })
			.mockResolvedValueOnce({ success: true, data: { success: false } })
			.mockResolvedValueOnce({ success: true, data: { success: true } });
		await openDialog();

		await userEvent.click(screen.getByRole("button", { name: "Create 3 PRs" }));

		await screen.findByText("1 succeeded, 2 failed");
		expect(
			screen.getAllByText("An unknown error occurred while creating the pull request"),
		).toHaveLength(2);
		// A success without a URL has no link and no board change.
		expect(screen.queryByRole("button", { name: /Pull request created/ })).not.toBeInTheDocument();
		expect(updateTask).not.toHaveBeenCalled();
	});

	it("reads a thrown error the same way", async () => {
		api.createWorktreePR
			.mockRejectedValueOnce(new Error("no branch for this task"))
			.mockRejectedValueOnce(new Error("push refused"))
			.mockRejectedValueOnce("not an error");
		await openDialog();

		await userEvent.click(screen.getByRole("button", { name: "Create 3 PRs" }));

		expect(await screen.findByText("0 succeeded, 1 skipped, 2 failed")).toBeInTheDocument();
		expect(screen.getByText("No worktree found for this task")).toBeInTheDocument();
		expect(screen.getByText("push refused")).toBeInTheDocument();
		expect(screen.getByText("An unknown error occurred while creating the pull request")).toBeInTheDocument();
	});

	it.each([
		["a reply", (p: ReturnType<typeof deferred<unknown>>) => p.resolve(created("u"))],
		["an error", (p: ReturnType<typeof deferred<unknown>>) => p.reject(new Error("x"))],
	])("stops the remaining PRs when closed with Escape, whatever %s brings", async (_l, settle) => {
		const first = deferred<unknown>();
		api.createWorktreePR.mockReturnValueOnce(first.promise).mockResolvedValue(created("u"));
		const onOpenChange = vi.fn();
		const onComplete = vi.fn();
		await openDialog({ onOpenChange, onComplete });

		await userEvent.click(screen.getByRole("button", { name: "Create 3 PRs" }));
		await userEvent.keyboard("{Escape}");
		expect(onOpenChange).toHaveBeenLastCalledWith(false);

		await act(async () => settle(first));
		expect(api.createWorktreePR).toHaveBeenCalledTimes(1);
		expect(onComplete).not.toHaveBeenCalled();
	});

	it("starts over when opened again", async () => {
		api.createWorktreePR.mockResolvedValue(created("u"));
		await openDialog({ tasks: [TASKS[0]] });
		await userEvent.type(screen.getByLabelText("Target branch"), "develop");
		await userEvent.click(screen.getByRole("button", { name: "Create 1 PRs" }));
		await screen.findByText("1 succeeded, 0 failed");

		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		await userEvent.click(screen.getByRole("button", { name: "open" }));

		expect(screen.getByLabelText("Target branch")).toHaveValue("");
		expect(screen.getByRole("button", { name: "Create 1 PRs" })).toBeEnabled();
	});

	it("cancels from the options", async () => {
		const onOpenChange = vi.fn();
		await openDialog({ onOpenChange });
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(api.createWorktreePR).not.toHaveBeenCalled();
	});
});
