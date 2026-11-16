/**
 * SubtaskFilesViewer — the files of one subtask as a tree, each with the lines
 * the build changed: the totals count this subtask's files only, a file's diff
 * opens one at a time and loads on demand, and the planned files stay listed
 * when the worktree has no diff to give.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../../__tests__/helpers/renderer-api";
import { stubModule, stubProps } from "../../../../__tests__/helpers/stub-component";
import i18n from "../../../../shared/i18n";
import type { WorktreeDiffFile } from "../../../../shared/types";
import { SubtaskFilesViewer } from "../SubtaskFilesViewer";

vi.mock("../../ui/diff-viewer", () => stubModule("DiffViewer"));

const diff = (path: string, additions: number, deletions: number, patch?: string): WorktreeDiffFile =>
	({ path, status: "modified", additions, deletions, patch }) as WorktreeDiffFile;

const FILES = ["src/export/csv.ts", "src/app.ts", "README.md"];

let api: RendererApi;

function useApi(overrides: Record<string, unknown>) {
	api?.restore();
	api = installRendererApi(overrides);
}

beforeEach(() => {
	useApi({
		getWorktreeDiff: vi.fn(async () => ({
			success: true,
			data: {
				files: [
					diff("src/export/csv.ts", 10, 2, "@@ -1 +1 @@\n-a\n+b"),
					diff("src/app.ts", 3, 0),
					// Another subtask's file, in the same branch.
					diff("src/other.ts", 100, 50),
				],
			},
		})),
		getFileDiff: vi.fn(async () => ({ success: true, data: diff("src/app.ts", 4, 1, "@@ patch @@") })),
	});
});

afterEach(async () => {
	cleanup();
	api.restore();
	vi.clearAllMocks();
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

function renderViewer(files = FILES, taskId: string | null = "t1") {
	const onClose = vi.fn();
	render(
		<SubtaskFilesViewer
			files={files}
			subtaskTitle="Add the export"
			taskId={taskId ?? undefined}
			onClose={onClose}
		/>,
	);
	return { onClose };
}

describe("SubtaskFilesViewer", () => {
	it("counts the lines of this subtask's files only, and its folders at every depth", async () => {
		const { onClose } = renderViewer();
		expect(screen.getByText("Loading changes…")).toBeInTheDocument();
		expect(await screen.findAllByText("+13")).toHaveLength(2);
		expect(screen.getByText("Add the export")).toBeInTheDocument();
		expect(screen.getByText("3 files modified")).toBeInTheDocument();
		expect(screen.getAllByText("-2")).toHaveLength(2);
		const stats = screen.getByText("Folders").previousElementSibling;
		expect(stats).toHaveTextContent("2");
		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalled();
	});

	it("opens one file's diff at a time and loads a missing one on demand", async () => {
		renderViewer();
		await screen.findAllByText("+13");
		await userEvent.click(screen.getByRole("button", { name: "Expand all" }));
		await userEvent.click(screen.getByRole("button", { name: /csv\.ts/ }));
		expect(stubProps("DiffViewer")).toMatchObject({ filePath: "src/export/csv.ts", patch: "@@ -1 +1 @@\n-a\n+b" });
		expect(globalThis.electronAPI.getFileDiff).not.toHaveBeenCalled();

		await userEvent.click(screen.getByRole("button", { name: /app\.ts/ }));
		expect(globalThis.electronAPI.getFileDiff).toHaveBeenCalledWith("t1", "src/app.ts");
		await waitFor(() => expect(stubProps("DiffViewer").filePath).toBe("src/app.ts"));
		expect(screen.getAllByTestId("stub-DiffViewer")).toHaveLength(1);
		// The diff loaded on demand replaces the summary's count, once.
		expect(screen.getAllByText("+14")).toHaveLength(2);

		await userEvent.click(screen.getByRole("button", { name: /app\.ts/ }));
		expect(screen.queryByTestId("stub-DiffViewer")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /app\.ts/ }));
		expect(globalThis.electronAPI.getFileDiff).toHaveBeenCalledTimes(1);

		await userEvent.click(screen.getByRole("button", { name: "Collapse all" }));
		expect(screen.queryByText("csv.ts")).toBeNull();
		expect(screen.queryByTestId("stub-DiffViewer")).toBeNull();
	});

	it("says a file has no recorded change, also when its diff cannot be read", async () => {
		await i18n.changeLanguage("fr");
		let answer: (value: unknown) => void = () => undefined;
		useApi({
			getWorktreeDiff: vi.fn(async () => ({ success: true, data: { files: [] } })),
			getFileDiff: vi
				.fn()
				.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
				.mockRejectedValueOnce(new Error("IPC")),
		});
		renderViewer(["README.md", "notes.md"]);
		await userEvent.click(await screen.findByRole("button", { name: /README\.md/ }));
		expect(screen.getAllByText("Chargement des modifications…").length).toBeGreaterThan(0);
		await act(async () => answer({ success: false }));
		expect(screen.getByText(i18n.t("tasks:subtasks.filesViewer.noDiff"))).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /notes\.md/ }));
		await waitFor(() => expect(screen.getByText(i18n.t("tasks:subtasks.filesViewer.noDiff"))).toBeInTheDocument());
	});

	it("still lists the planned files when the worktree gives no diff", async () => {
		useApi({ getWorktreeDiff: vi.fn(async () => ({ success: false, error: "No worktree" })) });
		renderViewer();
		expect(await screen.findByText("Unable to load changes for this task")).toBeInTheDocument();
		expect(screen.getByText("README.md")).toBeInTheDocument();
		cleanup();
		useApi({ getWorktreeDiff: vi.fn(async () => Promise.reject(new Error("IPC"))) });
		renderViewer();
		expect(await screen.findByRole("status")).toHaveTextContent("Unable to load changes");
	});

	it("without a task, reads no diff; without files, says so", async () => {
		renderViewer(FILES, null);
		expect(globalThis.electronAPI.getWorktreeDiff).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: /README\.md/ }));
		expect(globalThis.electronAPI.getFileDiff).not.toHaveBeenCalled();
		expect(screen.getByText("No recorded changes for this file")).toBeInTheDocument();
		cleanup();
		renderViewer([]);
		expect(await screen.findByText("No files modified yet")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Expand all" })).toBeNull();
	});

	it("drops the diff of a viewer that was closed meanwhile", async () => {
		let answer: (value: unknown) => void = () => undefined;
		useApi({ getWorktreeDiff: vi.fn(() => new Promise((resolve) => (answer = resolve))) });
		const { unmount } = render(
			<SubtaskFilesViewer files={FILES} subtaskTitle="x" taskId="t1" onClose={vi.fn()} />,
		);
		unmount();
		await act(async () => answer({ success: true, data: { files: [] } }));
		expect(screen.queryByText("+0")).toBeNull();
	});
});
