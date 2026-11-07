/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import type { Task } from "../../../shared/types";
import { TooltipProvider } from "../ui/tooltip";
import { TaskFiles } from "./TaskFiles";

const api = {
	getWorktreeStatus: vi.fn(),
	getWorktreeDiff: vi.fn(),
	worktreeReadFile: vi.fn(),
	listDirectory: vi.fn(),
	readFile: vi.fn(),
	worktreeOpenInIDE: vi.fn(),
};
Object.defineProperty(window, "electronAPI", { value: api, writable: true });

const WORKTREE = "/repo/.workpilot/worktrees/tasks/001-test";
const SPECS = "/repo/.workpilot/specs/001-test";

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "001-test",
		specId: "001-test",
		projectId: "proj-1",
		title: 'Créer un fichier test.txt et mettre "OK" dedans',
		description: "",
		status: "done",
		subtasks: [],
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as Task;
}

function renderFiles(task: Task) {
	return render(
		<TooltipProvider>
			<TaskFiles task={task} projectPath="/repo" />
		</TooltipProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	api.getWorktreeStatus.mockResolvedValue({
		success: true,
		data: { exists: true, worktreePath: WORKTREE },
	});
	api.getWorktreeDiff.mockResolvedValue({
		success: true,
		data: {
			files: [
				{
					path: "test.txt",
					status: "added",
					additions: 1,
					deletions: 0,
					patch: "diff --git a/test.txt b/test.txt\n+OK",
				},
			],
			summary: "1 files changed",
		},
	});
	api.worktreeReadFile.mockResolvedValue({ success: true, data: "OK\n" });
	api.listDirectory.mockResolvedValue({
		success: true,
		data: [
			{ name: "spec.md", path: `${SPECS}/spec.md`, isDirectory: false },
			{ name: "notes.txt", path: `${SPECS}/notes.txt`, isDirectory: false },
		],
	});
	api.readFile.mockResolvedValue({ success: true, data: "# Spec" });
});

describe("TaskFiles", () => {
	it("lists the file the task created and opens it first", async () => {
		renderFiles(makeTask({ specsPath: SPECS }));

		expect(await screen.findByRole("option", { name: /test\.txt/ })).toBeInTheDocument();
		// The spec folder is still there, filtered to .md/.json.
		expect(screen.getByRole("option", { name: /spec\.md/ })).toBeInTheDocument();
		expect(screen.queryByRole("option", { name: /notes\.txt/ })).toBeNull();

		await waitFor(() =>
			expect(api.worktreeReadFile).toHaveBeenCalledWith(WORKTREE, "test.txt"),
		);
		expect(await screen.findByText("OK")).toBeInTheDocument();
	});

	it("shows the task's files even when the task carries no spec folder", async () => {
		// A task created during the session used to come without specsPath and
		// the tab said "no spec files" although test.txt existed.
		renderFiles(makeTask({ specsPath: undefined }));

		expect(await screen.findByRole("option", { name: /test\.txt/ })).toBeInTheDocument();
		expect(api.listDirectory).not.toHaveBeenCalled();
	});

	it("shows a spec file's content when it is selected", async () => {
		renderFiles(makeTask({ specsPath: SPECS }));

		fireEvent.click(await screen.findByRole("option", { name: /spec\.md/ }));
		await waitFor(() =>
			expect(api.readFile).toHaveBeenCalledWith(`${SPECS}/spec.md`),
		);
		expect(await screen.findByText("# Spec")).toBeInTheDocument();
	});

	it("keeps the user's pick when the auto-selected file answers late", async () => {
		let answer: ((value: { success: boolean; data: string }) => void) | undefined;
		api.worktreeReadFile.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		renderFiles(makeTask({ specsPath: SPECS }));

		await waitFor(() => expect(api.worktreeReadFile).toHaveBeenCalled());
		fireEvent.click(screen.getByRole("option", { name: /spec\.md/ }));
		expect(await screen.findByText("# Spec")).toBeInTheDocument();

		answer?.({ success: true, data: "OK\n" });
		await waitFor(() => expect(screen.getByText("# Spec")).toBeInTheDocument());
		expect(screen.queryByText("OK")).not.toBeInTheDocument();
		expect(screen.getByRole("option", { name: /spec\.md/ })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	it("falls back to the subtasks' files, read from the project, when the worktree is gone", async () => {
		api.getWorktreeStatus.mockResolvedValue({ success: true, data: { exists: false } });
		api.getWorktreeDiff.mockResolvedValue({
			success: false,
			error: "No worktree found for this task",
		});
		renderFiles(
			makeTask({
				subtasks: [
					{
						id: "1",
						title: "",
						description: "",
						status: "completed",
						files: ["test.txt"],
					},
				],
			}),
		);

		expect(await screen.findByRole("option", { name: /test\.txt/ })).toBeInTheDocument();
		await waitFor(() =>
			expect(api.worktreeReadFile).toHaveBeenCalledWith("/repo", "test.txt"),
		);
	});

	it("shows the diff of a deleted file", async () => {
		api.getWorktreeDiff.mockResolvedValue({
			success: true,
			data: {
				files: [
					{
						path: "old.txt",
						status: "deleted",
						additions: 0,
						deletions: 1,
						patch: "diff --git a/old.txt b/old.txt\n-gone",
					},
				],
				summary: "",
			},
		});
		renderFiles(makeTask());

		expect(await screen.findByText("-gone")).toBeInTheDocument();
		expect(api.worktreeReadFile).not.toHaveBeenCalled();
	});

	it("reports a git failure instead of an empty list", async () => {
		api.getWorktreeDiff.mockResolvedValue({
			success: false,
			error: "fatal: bad revision 'main'",
		});
		renderFiles(makeTask({ specsPath: SPECS }));

		expect(await screen.findByText("fatal: bad revision 'main'")).toBeInTheDocument();
	});

	it("says so when the task changed nothing", async () => {
		api.getWorktreeDiff.mockResolvedValue({
			success: true,
			data: { files: [], summary: "" },
		});
		renderFiles(makeTask({ specsPath: SPECS }));

		expect(
			await screen.findByText(/n'a créé ni modifié|created or changed no files/),
		).toBeInTheDocument();
	});
});
