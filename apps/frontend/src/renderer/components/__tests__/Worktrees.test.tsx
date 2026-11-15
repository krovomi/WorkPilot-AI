/**
 * @vitest-environment jsdom
 */
/**
 * The Worktrees page: listing task and terminal worktrees, merging, creating
 * a PR, deleting one or many, and every error those calls can return.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";
import { useProjectStore } from "../../stores/project-store";
import { useTaskStore } from "../../stores/task-store";
import { Worktrees } from "../Worktrees";

const toast = vi.hoisted(() => vi.fn());
vi.mock("../../hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

const api = {
	listWorktrees: vi.fn(),
	listTerminalWorktrees: vi.fn(),
	mergeWorktree: vi.fn(),
	discardWorktree: vi.fn(),
	discardOrphanedWorktree: vi.fn(),
	removeTerminalWorktree: vi.fn(),
	createWorktreePR: vi.fn(),
	analyzeWorktreeImpact: vi.fn(),
	openExternal: vi.fn(),
	toHostPath: vi.fn(),
};

const taskWorktree = {
	specName: "001-login",
	path: "/repo/.workpilot/worktrees/001-login",
	branch: "workpilot/001-login",
	baseBranch: "develop",
	commitCount: 3,
	filesChanged: 4,
	additions: 20,
	deletions: 5,
};
const orphan = {
	specName: "002-ghost",
	path: "/repo/.workpilot/worktrees/002-ghost",
	branch: "workpilot/002-ghost",
	baseBranch: "",
	isOrphaned: true,
};
const stray = {
	specName: "003-stray",
	path: "/repo/.workpilot/worktrees/003-stray",
	branch: "workpilot/003-stray",
	baseBranch: "main",
};
const terminalWorktree = {
	name: "scratch",
	worktreePath: "/repo/.workpilot/terminal-worktrees/scratch",
	branchName: "terminal/scratch",
	baseBranch: "develop",
	hasGitBranch: true,
	taskId: "T-9",
	createdAt: "2026-11-01T10:00:00Z",
};

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "task-1",
		specId: "001-login",
		projectId: "p1",
		title: "Login page",
		description: "",
		status: "human_review",
		subtasks: [],
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as Task;
}

// The dialog has an icon « Close » button too: take the one with the word.
function footerClose(dialog: HTMLElement) {
	const button = within(dialog)
		.getAllByRole("button", { name: "Close" })
		.find((b) => b.textContent === "Close");
	if (!button) throw new Error("no footer Close button");
	return button;
}

function listing(worktrees: unknown[], terminals: unknown[] = []) {
	api.listWorktrees.mockResolvedValue({ success: true, data: { worktrees } });
	api.listTerminalWorktrees.mockResolvedValue({ success: true, data: terminals });
}

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(globalThis.electronAPI, api);
	api.analyzeWorktreeImpact.mockResolvedValue({ success: false });
	api.toHostPath.mockImplementation(async (p: string) => p);
	Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
	useProjectStore.setState({
		projects: [{ id: "p1", name: "Repo", path: "/repo" } as never],
	});
	useTaskStore.setState({ tasks: [task()] });
	listing([taskWorktree], [terminalWorktree]);
});

describe("Worktrees listing", () => {
	it("asks for a project when none matches", () => {
		render(<Worktrees projectId="unknown" />);
		expect(screen.getByText("Select a project to view worktrees")).toBeInTheDocument();
		expect(api.listWorktrees).not.toHaveBeenCalled();
	});

	it("shows task and terminal worktrees with their stats", async () => {
		render(<Worktrees projectId="p1" />);
		expect(await screen.findByText("Login page")).toBeInTheDocument();
		expect(screen.getAllByText("workpilot/001-login")).toHaveLength(2);
		expect(api.listWorktrees).toHaveBeenCalledWith("p1", { includeStats: true });
		expect(api.listTerminalWorktrees).toHaveBeenCalledWith("/repo");
		expect(screen.getByText("4 files changed")).toBeInTheDocument();
		expect(screen.getByText("3 commits ahead")).toBeInTheDocument();
		expect(screen.getByText("20")).toBeInTheDocument();
		expect(screen.getByText("2 worktrees")).toBeInTheDocument();
		expect(screen.getByText("Terminal Worktrees")).toBeInTheDocument();
		expect(screen.getByText("scratch")).toBeInTheDocument();
		expect(screen.getByText("T-9")).toBeInTheDocument();
		expect(screen.getByText(/^Created /)).toBeInTheDocument();
	});

	it("labels an orphan and disables merge without a task", async () => {
		listing([orphan, stray]);
		render(<Worktrees projectId="p1" />);
		await screen.findByText("002-ghost");
		expect(screen.getAllByText("(orphaned)").length).toBeGreaterThan(1);
		const merges = screen.getAllByRole("button", { name: /Merge to/ });
		expect(merges.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
		const deletes = screen.getAllByRole("button", { name: "Delete" });
		// The orphan can be deleted by name; a worktree with neither task nor orphan flag cannot.
		expect(deletes[0]).not.toBeDisabled();
		expect(deletes[1]).toBeDisabled();
	});

	it("shows the empty state", async () => {
		listing([], []);
		render(<Worktrees projectId="p1" />);
		expect(await screen.findByText("No Worktrees")).toBeInTheDocument();
	});

	it("shows why task worktrees did not load, and keeps terminal ones", async () => {
		api.listWorktrees.mockResolvedValue({ success: false, error: "not a git repo" });
		api.listTerminalWorktrees.mockResolvedValue({ success: false });
		render(<Worktrees projectId="p1" />);
		expect(await screen.findByRole("alert")).toHaveTextContent("not a git repo");
	});

	it("falls back to a translated message", async () => {
		api.listWorktrees.mockResolvedValue({ success: false });
		render(<Worktrees projectId="p1" />);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not load the worktrees.",
		);
	});

	it("reports a thrown listing error", async () => {
		api.listWorktrees.mockRejectedValueOnce(new Error("ipc closed"));
		render(<Worktrees projectId="p1" />);
		expect(await screen.findByRole("alert")).toHaveTextContent("ipc closed");
		api.listWorktrees.mockRejectedValueOnce("raw");
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(
				"Could not load the worktrees.",
			),
		);
	});

	it("copies the host path of a worktree", async () => {
		api.toHostPath.mockResolvedValue("\\\\wsl.localhost\\Ubuntu\\repo");
		render(<Worktrees projectId="p1" />);
		await screen.findByText("Login page");
		fireEvent.click(screen.getAllByRole("button", { name: "Copy Path" })[0]);
		await waitFor(() =>
			expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
				"\\\\wsl.localhost\\Ubuntu\\repo",
			),
		);
		fireEvent.click(screen.getAllByRole("button", { name: "Copy Path" })[1]);
		await waitFor(() => expect(api.toHostPath).toHaveBeenCalledWith(terminalWorktree.worktreePath));
	});

	it("opens the PR of a done task", async () => {
		useTaskStore.setState({
			tasks: [task({ status: "done", metadata: { prUrl: "https://forge/pr/7" } })],
		});
		render(<Worktrees projectId="p1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Open PR" }));
		expect(api.openExternal).toHaveBeenCalledWith("https://forge/pr/7");
	});
});

describe("Worktrees merge", () => {
	async function openMerge() {
		render(<Worktrees projectId="p1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Merge to develop" }));
		return screen.findByRole("dialog");
	}

	it("summarises the merge, merges, and reloads on success", async () => {
		api.mergeWorktree.mockResolvedValue({
			success: true,
			data: { success: true, message: "Fast-forwarded develop" },
		});
		const dialog = await openMerge();
		expect(within(dialog).getByText("3 commits, 4 files")).toBeInTheDocument();
		fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
		expect(await within(dialog).findByText("Merge Successful")).toBeInTheDocument();
		expect(within(dialog).getByText("Fast-forwarded develop")).toBeInTheDocument();
		expect(api.mergeWorktree).toHaveBeenCalledWith("task-1");
		expect(api.listWorktrees).toHaveBeenCalledTimes(2);
		fireEvent.click(footerClose(dialog));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("lists the conflicting files of a failed merge", async () => {
		api.mergeWorktree.mockResolvedValue({
			success: true,
			data: { success: false, message: "Conflicts", conflictFiles: ["src/a.ts"] },
		});
		const dialog = await openMerge();
		fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
		expect(await within(dialog).findByText("Merge Failed")).toBeInTheDocument();
		expect(within(dialog).getByText("src/a.ts")).toBeInTheDocument();
		expect(api.listWorktrees).toHaveBeenCalledTimes(1);
	});

	it("shows an IPC refusal, its fallback and a thrown error", async () => {
		api.mergeWorktree
			.mockResolvedValueOnce({ success: false, error: "dirty tree" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("crash"))
			.mockRejectedValueOnce("raw");
		let dialog = await openMerge();
		for (const message of ["dirty tree", "An unknown error occurred", "crash", "An unknown error occurred"]) {
			fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
			expect(await within(dialog).findByText(message)).toBeInTheDocument();
			fireEvent.click(footerClose(dialog));
			await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
			fireEvent.click(screen.getByRole("button", { name: "Merge to develop" }));
			dialog = await screen.findByRole("dialog");
		}
	});

	it("says when the task of the worktree vanished before merging", async () => {
		const dialog = await openMerge();
		act(() => useTaskStore.setState({ tasks: [] }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
		// Said in the dialog, which hides the page behind it.
		expect(
			await within(dialog).findByText("No task matches this worktree."),
		).toBeInTheDocument();
		expect(within(dialog).getByText("Merge Failed")).toBeInTheDocument();
		expect(api.mergeWorktree).not.toHaveBeenCalled();
	});
});

describe("Worktrees create PR", () => {
	async function submitPR() {
		render(<Worktrees projectId="p1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Create PR" }));
		const dialog = await screen.findByRole("dialog");
		await waitFor(() => expect(api.analyzeWorktreeImpact).toHaveBeenCalled());
		fireEvent.click(
			await within(dialog).findByRole("button", { name: "Create Pull Request" }),
		);
		return dialog;
	}

	it("creates the PR and marks the task done with its URL", async () => {
		api.createWorktreePR.mockResolvedValue({
			success: true,
			data: { success: true, prUrl: "https://forge/pr/9", alreadyExists: false },
		});
		await submitPR();
		await waitFor(() =>
			expect(useTaskStore.getState().tasks[0]).toMatchObject({
				status: "done",
				metadata: { prUrl: "https://forge/pr/9" },
			}),
		);
		expect(api.createWorktreePR.mock.calls[0][0]).toBe("task-1");
	});

	it("leaves the task alone when the PR already existed", async () => {
		api.createWorktreePR.mockResolvedValue({
			success: true,
			data: { success: true, prUrl: "https://forge/pr/9", alreadyExists: true },
		});
		await submitPR();
		await waitFor(() => expect(api.createWorktreePR).toHaveBeenCalled());
		expect(useTaskStore.getState().tasks[0].status).toBe("human_review");
	});

	it("passes the IPC error to the dialog", async () => {
		api.createWorktreePR.mockResolvedValue({ success: false, error: "no remote" });
		const dialog = await submitPR();
		expect(await within(dialog).findByText("no remote")).toBeInTheDocument();
	});

	it("passes a thrown error to the dialog", async () => {
		api.createWorktreePR.mockRejectedValue(new Error("gh not found"));
		const dialog = await submitPR();
		expect(await within(dialog).findByText("gh not found")).toBeInTheDocument();
	});
});

describe("Worktrees delete", () => {
	it("deletes a task worktree and confirms with a toast", async () => {
		api.discardWorktree.mockResolvedValue({ success: true });
		render(<Worktrees projectId="p1" />);
		await screen.findByText("Login page");
		fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText("workpilot/001-login")).toBeInTheDocument();
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(api.discardWorktree).toHaveBeenCalledWith("task-1"));
		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith({
				title: "Success",
				description: "Worktree 'workpilot/001-login' deleted successfully",
			}),
		);
	});

	it("deletes an orphan by its spec name", async () => {
		listing([orphan]);
		api.discardOrphanedWorktree.mockResolvedValue({ success: true });
		render(<Worktrees projectId="p1" />);
		await screen.findByText("002-ghost");
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		fireEvent.click(
			within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }),
		);
		await waitFor(() =>
			expect(api.discardOrphanedWorktree).toHaveBeenCalledWith("p1", "002-ghost"),
		);
	});

	it("shows a refused, fallback and thrown delete", async () => {
		api.discardWorktree
			.mockResolvedValueOnce({ success: false, error: "locked" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("EBUSY"))
			.mockRejectedValueOnce("raw");
		render(<Worktrees projectId="p1" />);
		await screen.findByText("Login page");
		for (const message of ["locked", "Could not delete the worktree.", "EBUSY", "Could not delete the worktree."]) {
			fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
			fireEvent.click(
				within(await screen.findByRole("alertdialog")).getByRole("button", {
					name: "Delete",
				}),
			);
			await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
		}
	});

	it("refuses a worktree whose task vanished", async () => {
		render(<Worktrees projectId="p1" />);
		await screen.findByText("Login page");
		fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
		const dialog = await screen.findByRole("alertdialog");
		act(() => useTaskStore.setState({ tasks: [] }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Task not found for worktree: 001-login",
		);
		expect(api.discardWorktree).not.toHaveBeenCalled();
	});

	it("deletes a terminal worktree with its branch", async () => {
		api.removeTerminalWorktree.mockResolvedValue({ success: true });
		render(<Worktrees projectId="p1" />);
		await screen.findByText("scratch");
		fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText("Delete Terminal Worktree?")).toBeInTheDocument();
		expect(within(dialog).getByText(/terminal\/scratch/)).toBeInTheDocument();
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() =>
			expect(api.removeTerminalWorktree).toHaveBeenCalledWith("/repo", "scratch", true),
		);
		expect(api.listWorktrees).toHaveBeenCalledTimes(2);
	});

	it("shows why a terminal worktree was not deleted", async () => {
		api.removeTerminalWorktree
			.mockResolvedValueOnce({ success: false, error: "in use" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("EPERM"))
			.mockRejectedValueOnce("raw");
		render(<Worktrees projectId="p1" />);
		await screen.findByText("scratch");
		for (const message of ["in use", "Could not delete the terminal worktree.", "EPERM", "Could not delete the terminal worktree."]) {
			fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
			fireEvent.click(
				within(await screen.findByRole("alertdialog")).getByRole("button", {
					name: "Delete",
				}),
			);
			await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
		}
	});
});

describe("Worktrees bulk delete", () => {
	async function selectMode() {
		render(<Worktrees projectId="p1" />);
		await screen.findByText("scratch");
		fireEvent.click(screen.getByRole("button", { name: "Select" }));
	}

	it("selects all, counts, and deletes every kind of worktree", async () => {
		listing([taskWorktree, orphan], [terminalWorktree]);
		api.discardWorktree.mockResolvedValue({ success: true });
		api.discardOrphanedWorktree.mockResolvedValue({ success: true });
		api.removeTerminalWorktree.mockResolvedValue({ success: true });
		await selectMode();
		expect(screen.getByText("0 of 3 selected")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Delete \(0\)/ })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		expect(screen.getByText("3 of 3 selected")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Delete \(3\)/ }));
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText("Delete 3 Worktrees?")).toBeInTheDocument();
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete Selected" }));
		await waitFor(() =>
			expect(toast).toHaveBeenCalledWith({
				title: "Success",
				description: "3 worktrees deleted successfully",
			}),
		);
		expect(api.discardWorktree).toHaveBeenCalledWith("task-1");
		expect(api.discardOrphanedWorktree).toHaveBeenCalledWith("p1", "002-ghost");
		expect(api.removeTerminalWorktree).toHaveBeenCalledWith("/repo", "scratch", true);
	});

	it("toggles single worktrees, clears the selection and leaves selection mode", async () => {
		await selectMode();
		const boxes = screen.getAllByRole("checkbox");
		fireEvent.click(boxes[0]);
		expect(screen.getByText("1 of 2 selected")).toBeInTheDocument();
		fireEvent.click(boxes[0]);
		expect(screen.getByText("0 of 2 selected")).toBeInTheDocument();
		fireEvent.click(boxes[1]);
		fireEvent.click(boxes[0]);
		expect(screen.getByRole("button", { name: "Clear Selection" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Clear Selection" }));
		expect(screen.getByText("0 of 2 selected")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(screen.queryByRole("checkbox")).toBeNull();
	});

	it("collects every failure into one message", async () => {
		listing([taskWorktree, orphan, stray], [terminalWorktree]);
		useTaskStore.setState({
			tasks: [task(), task({ id: "task-3", specId: "003-stray" })],
		});
		api.discardWorktree
			.mockResolvedValueOnce({ success: false, error: "locked" })
			.mockRejectedValueOnce(new Error("EBUSY"));
		api.discardOrphanedWorktree.mockResolvedValue({ success: false });
		api.removeTerminalWorktree.mockRejectedValue("raw");
		await selectMode();
		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		fireEvent.click(screen.getByRole("button", { name: /Delete \(4\)/ }));
		fireEvent.click(
			within(await screen.findByRole("alertdialog")).getByRole("button", {
				name: "Delete Selected",
			}),
		);
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Some worktrees could not be deleted:");
		expect(alert).toHaveTextContent("locked");
		expect(alert).toHaveTextContent("Failed to delete task worktree: 002-ghost");
		expect(alert).toHaveTextContent("EBUSY");
		expect(alert).toHaveTextContent("Failed to delete terminal worktree: scratch");
		expect(toast).not.toHaveBeenCalled();
	});

	it("reports a task that vanished and a terminal refusal", async () => {
		api.removeTerminalWorktree
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("EPERM"));
		await selectMode();
		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		act(() => useTaskStore.setState({ tasks: [] }));
		fireEvent.click(screen.getByRole("button", { name: /Delete \(2\)/ }));
		fireEvent.click(
			within(await screen.findByRole("alertdialog")).getByRole("button", {
				name: "Delete Selected",
			}),
		);
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Task not found for worktree: 001-login");
		expect(alert).toHaveTextContent("Failed to delete terminal worktree: scratch");
		// Second run: the thrown terminal error is quoted.
		fireEvent.click(screen.getByRole("button", { name: "Select" }));
		fireEvent.click(screen.getAllByRole("checkbox")[1]);
		fireEvent.click(screen.getByRole("button", { name: /Delete \(1\)/ }));
		fireEvent.click(
			within(await screen.findByRole("alertdialog")).getByRole("button", {
				name: "Delete Selected",
			}),
		);
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("EPERM"));
	});
});
