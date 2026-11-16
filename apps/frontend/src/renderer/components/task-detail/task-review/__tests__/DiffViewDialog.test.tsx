/**
 * DiffViewDialog — the files a build changed, as a tree or a flat list, each
 * diff opened under its row one at a time. With a worktree, a file can be
 * edited or added, and selected files discarded after a second click: a file
 * that cannot be read never opens an empty editor, and every failure says so.
 */

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../../../__tests__/helpers/renderer-api";
import { callStub, resetStubs, stubModule, stubProps } from "../../../../../__tests__/helpers/stub-component";
import i18n from "../../../../../shared/i18n";
import type { WorktreeDiff, WorktreeDiffFile } from "../../../../../shared/types";
import { TooltipProvider } from "../../../ui/tooltip";
import { DiffViewDialog } from "../DiffViewDialog";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock("../../../ui/diff-viewer", () => stubModule("DiffViewer"));
vi.mock("../../../ui/code-editor", () => stubModule("CodeEditor"));
vi.mock("../../../../hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

const file = (
	path: string,
	status: WorktreeDiffFile["status"],
	additions: number,
	deletions: number,
	patch?: string,
): WorktreeDiffFile => ({ path, status, additions, deletions, patch }) as WorktreeDiffFile;

const DIFF: WorktreeDiff = {
	files: [
		file("src/export/csv.ts", "modified", 10, 2, "@@ csv @@"),
		file("README.md", "added", 3, 0, "@@ readme @@"),
		file("src/app.ts", "deleted", 0, 7, "  "),
	],
	summary: "",
} as WorktreeDiff;

let api: RendererApi;

// Radix Select reads pointer capture, which jsdom does not have.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => undefined;

function useApi(overrides: Record<string, unknown>) {
	api?.restore();
	api = installRendererApi(overrides);
}

beforeEach(() => {
	useApi({
		worktreeReadFile: vi.fn(async () => ({ success: true, data: "old text" })),
		worktreeWriteFile: vi.fn(async () => ({ success: true })),
		worktreeDeleteFiles: vi.fn(async (_path: string, paths: string[]) => ({
			success: true,
			data: { deleted: paths, failed: [] },
		})),
	});
});

afterEach(async () => {
	cleanup();
	api.restore();
	resetStubs();
	vi.clearAllMocks();
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

function renderDialog(props: { diff?: WorktreeDiff | null; worktreePath?: string } = {}) {
	const onRefresh = vi.fn();
	const onOpenChange = vi.fn();
	render(
		<DiffViewDialog
			open
			worktreeDiff={props.diff === undefined ? DIFF : props.diff}
			onOpenChange={onOpenChange}
			worktreePath={"worktreePath" in props ? props.worktreePath : "/wt"}
			onRefresh={onRefresh}
		/>,
		{ wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider> },
	);
	return { onRefresh, onOpenChange, dialog: screen.getByRole("alertdialog") };
}

const write = () => globalThis.electronAPI.worktreeWriteFile as unknown as ReturnType<typeof vi.fn>;
const discard = () => globalThis.electronAPI.worktreeDeleteFiles as unknown as ReturnType<typeof vi.fn>;
const lastToast = () => toast.mock.calls.at(-1)?.[0];

describe("DiffViewDialog", () => {
	it("shows the tree, folders first, and opens one diff at a time", async () => {
		const { dialog, onOpenChange } = renderDialog({ worktreePath: undefined });
		expect(within(dialog).getByText("3 files changed")).toBeInTheDocument();
		const rows = within(dialog).getAllByText(/^(src|export|csv\.ts|app\.ts|README\.md)$/).map((n) => n.textContent);
		expect(rows).toEqual(["src", "export", "csv.ts", "app.ts", "README.md"]);
		// Without a worktree, nothing can be changed.
		expect(within(dialog).queryByRole("checkbox")).toBeNull();
		expect(within(dialog).queryByRole("button", { name: "Edit" })).toBeNull();
		expect(within(dialog).queryByRole("button", { name: "Add File" })).toBeNull();

		await userEvent.click(within(dialog).getByText("csv.ts"));
		expect(stubProps("DiffViewer")).toMatchObject({ patch: "@@ csv @@", filePath: "src/export/csv.ts" });
		await userEvent.click(within(dialog).getByRole("button", { name: "Side by side" }));
		expect(stubProps("DiffViewer").viewMode).toBe("split");
		await userEvent.click(within(dialog).getByText("README.md"));
		expect(screen.getAllByTestId("stub-DiffViewer")).toHaveLength(1);
		expect(stubProps("DiffViewer").patch).toBe("@@ readme @@");
		await userEvent.click(within(dialog).getByText("README.md"));
		expect(screen.queryByTestId("stub-DiffViewer")).toBeNull();
		// A blank patch has nothing to show.
		await userEvent.click(within(dialog).getByText("app.ts"));
		expect(within(dialog).getByText("No changes found")).toBeInTheDocument();

		await userEvent.click(within(dialog).getByRole("button", { name: "Collapse all" }));
		expect(within(dialog).queryByText("csv.ts")).toBeNull();
		expect(within(dialog).queryByText("No changes found")).toBeNull();
		await userEvent.click(within(dialog).getByRole("button", { name: "Expand all" }));
		expect(within(dialog).getByText("csv.ts")).toBeInTheDocument();
		await userEvent.click(within(dialog).getByText("export"));
		expect(within(dialog).queryByText("csv.ts")).toBeNull();

		await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("as a flat list, expands every diff and selects every file", async () => {
		const { dialog } = renderDialog();
		await userEvent.click(within(dialog).getByRole("combobox"));
		await userEvent.click(await screen.findByRole("option", { name: "Flat list" }));
		expect(within(dialog).getByText("src/export/csv.ts")).toBeInTheDocument();

		await userEvent.click(within(dialog).getByRole("button", { name: "Expand all" }));
		expect(screen.getAllByTestId("stub-DiffViewer")).toHaveLength(2);
		await userEvent.click(within(dialog).getByRole("button", { name: "Collapse all" }));
		expect(screen.queryByTestId("stub-DiffViewer")).toBeNull();
		await userEvent.click(within(dialog).getByText("src/export/csv.ts"));
		expect(screen.getAllByTestId("stub-DiffViewer")).toHaveLength(1);

		await userEvent.click(within(dialog).getByRole("checkbox", { name: "Select README.md" }));
		expect(within(dialog).getByText("Select all (1 selected)")).toBeInTheDocument();
		// The edit buttons and the view tools step aside while files are selected.
		expect(within(dialog).queryByRole("button", { name: "Expand all" })).toBeNull();
		const selectAll = within(dialog).getByRole("checkbox", { name: /^Select all/ });
		await userEvent.click(selectAll);
		expect(within(dialog).getAllByText("3 files selected")).toHaveLength(2);
		await userEvent.click(selectAll);
		expect(within(dialog).queryByText(/files selected/)).toBeNull();

		await userEvent.click(within(dialog).getAllByRole("button", { name: "Edit" })[0]);
		expect(globalThis.electronAPI.worktreeReadFile).toHaveBeenCalledWith("/wt", "src/export/csv.ts");
	});

	it("edits a file and saves it, and keeps the editor open when the save fails", async () => {
		let answer: (value: unknown) => void = () => undefined;
		(globalThis.electronAPI.worktreeReadFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
			() => new Promise((resolve) => (answer = resolve)),
		);
		write().mockResolvedValueOnce({ success: false, error: "EACCES" });
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { dialog, onRefresh } = renderDialog();
		await userEvent.click(within(dialog).getAllByRole("button", { name: "Edit" })[0]);
		expect(within(dialog).getByText("Edit File")).toBeInTheDocument();
		// Nothing can be saved before the file is read.
		expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
		await act(async () => answer({ success: true, data: "old text" }));
		expect(stubProps("CodeEditor")).toMatchObject({ value: "old text", filename: "src/export/csv.ts" });
		act(() => {
			callStub("CodeEditor", "onChange", "new text");
		});

		await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(write()).toHaveBeenCalledWith("/wt", "src/export/csv.ts", "new text");
		expect(lastToast()).toMatchObject({ description: "Could not save src/export/csv.ts.", variant: "destructive" });
		expect(error).toHaveBeenCalled();
		expect(onRefresh).not.toHaveBeenCalled();
		expect(stubProps("CodeEditor").value).toBe("new text");

		await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(within(dialog).getByText("Changed Files")).toBeInTheDocument();

		// Cancel, from the footer or the back arrow, leaves without writing.
		await userEvent.click(within(dialog).getAllByRole("button", { name: "Edit" })[0]);
		await userEvent.click(within(dialog).getAllByRole("button", { name: "Cancel" }).at(-1) as HTMLElement);
		await userEvent.click(within(dialog).getAllByRole("button", { name: "Edit" })[0]);
		await userEvent.click(within(dialog).getByTitle("Cancel"));
		expect(within(dialog).getByText("Changed Files")).toBeInTheDocument();
		expect(write()).toHaveBeenCalledTimes(2);
	});

	it("never opens an empty editor on a file it could not read", async () => {
		await i18n.changeLanguage("fr");
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		(globalThis.electronAPI.worktreeReadFile as unknown as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ success: false, error: "ENOENT" })
			.mockRejectedValueOnce(new Error("IPC"));
		const { dialog } = renderDialog();
		for (let attempt = 0; attempt < 2; attempt++) {
			await userEvent.click(within(dialog).getAllByRole("button", { name: "Modifier" })[0]);
			await waitFor(() => expect(within(dialog).getByText("Fichiers modifiés")).toBeInTheDocument());
			expect(screen.queryByTestId("stub-CodeEditor")).toBeNull();
			expect(lastToast()).toMatchObject({ title: "Erreur", description: "Impossible de lire src/export/csv.ts." });
		}
		expect(write()).not.toHaveBeenCalled();
	});

	it("adds a file once it has a path, and says when it cannot be created", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		write().mockResolvedValueOnce({ success: false, error: "EACCES" }).mockRejectedValueOnce(new Error("IPC"));
		const { dialog, onRefresh } = renderDialog();
		await userEvent.click(within(dialog).getByRole("button", { name: "Add File" }));
		expect(within(dialog).getByText("Adding new file")).toBeInTheDocument();
		const create = within(dialog).getByRole("button", { name: "Create" });
		expect(create).toBeDisabled();
		await userEvent.type(within(dialog).getByLabelText("File path"), "src/new.ts");
		act(() => {
			callStub("CodeEditor", "onChange", "export {};");
		});
		for (let attempt = 0; attempt < 2; attempt++) {
			await userEvent.click(create);
			expect(lastToast()).toMatchObject({ description: "Could not create src/new.ts." });
		}
		expect(toast).toHaveBeenCalledTimes(2);
		await userEvent.click(create);
		expect(write()).toHaveBeenLastCalledWith("/wt", "src/new.ts", "export {};");
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(within(dialog).getByText("Changed Files")).toBeInTheDocument();

		await userEvent.click(within(dialog).getByRole("button", { name: "Add File" }));
		await userEvent.click(within(dialog).getAllByRole("button", { name: "Cancel" }).at(-1) as HTMLElement);
		await userEvent.click(within(dialog).getByRole("button", { name: "Add File" }));
		await userEvent.click(within(dialog).getByTitle("Cancel"));
		expect(within(dialog).getByText("Changed Files")).toBeInTheDocument();
	});

	it("discards the selected files only on a second click, and asks again for another selection", async () => {
		const { dialog, onRefresh } = renderDialog();
		const readme = within(dialog).getByRole("checkbox", { name: "Select README.md" });
		await userEvent.click(readme);
		await userEvent.click(readme);
		expect(within(dialog).queryByText(/selected/)).toBeNull();
		await userEvent.click(readme);
		expect(within(dialog).getAllByText("1 file selected")).toHaveLength(2);
		await userEvent.click(within(dialog).getByRole("button", { name: "Discard selected" }));
		expect(discard()).not.toHaveBeenCalled();
		expect(within(dialog).getByRole("status")).toHaveTextContent("new files are deleted");
		expect(within(dialog).getByRole("button", { name: "Discard 1 file for good" })).toBeInTheDocument();

		await userEvent.click(within(dialog).getByRole("checkbox", { name: "Select src/app.ts" }));
		expect(within(dialog).queryByRole("status")).toBeNull();
		await userEvent.click(within(dialog).getByRole("button", { name: "Discard selected" }));
		await userEvent.click(within(dialog).getByRole("button", { name: "Discard 2 files for good" }));
		expect(discard()).toHaveBeenCalledWith("/wt", ["README.md", "src/app.ts"]);
		expect(lastToast()).toEqual({
			title: "Changes discarded",
			description: "2 files are back to the base branch",
		});
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(within(dialog).queryByText(/selected/)).toBeNull();
	});

	it("keeps selected what could not be discarded, and says so", async () => {
		await i18n.changeLanguage("fr");
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		discard()
			.mockResolvedValueOnce({ success: true, data: { deleted: ["README.md"], failed: ["src/app.ts"] } })
			.mockResolvedValueOnce({ success: true, data: { deleted: [], failed: ["src/app.ts"] } })
			.mockResolvedValueOnce({ success: false, error: "Expected a list of paths" })
			// An answer without its lists says nothing was discarded.
			.mockResolvedValueOnce({ success: true });
		const { dialog } = renderDialog();
		await userEvent.click(within(dialog).getByRole("checkbox", { name: "Sélectionner README.md" }));
		await userEvent.click(within(dialog).getByRole("checkbox", { name: "Sélectionner src/app.ts" }));
		await userEvent.click(within(dialog).getByRole("button", { name: "Abandonner les modifications" }));
		await userEvent.click(within(dialog).getByRole("button", { name: "Abandonner définitivement 2 fichiers" }));
		expect(toast.mock.calls.map(([call]) => call.description)).toEqual([
			"1 fichier est revenu à la branche de base",
			"Abandon impossible : src/app.ts",
		]);
		expect(within(dialog).getAllByText("1 fichier sélectionné")).toHaveLength(2);

		await userEvent.click(within(dialog).getByRole("button", { name: "Abandonner les modifications" }));
		await userEvent.click(within(dialog).getByRole("button", { name: "Abandonner définitivement 1 fichier" }));
		expect(lastToast()).toMatchObject({ description: "Abandon impossible : src/app.ts", variant: "destructive" });
		expect(toast).toHaveBeenCalledTimes(3);
		expect(within(dialog).getAllByText("1 fichier sélectionné")).toHaveLength(2);
		for (let attempt = 0; attempt < 2; attempt++) {
			await userEvent.click(within(dialog).getByRole("button", { name: "Abandonner les modifications" }));
			await userEvent.click(within(dialog).getByRole("button", { name: "Abandonner définitivement 1 fichier" }));
		}
		expect(toast).toHaveBeenCalledTimes(5);
		expect(toast.mock.calls.slice(2).every(([call]) => call.variant === "destructive")).toBe(true);
	});

	it("says when there is nothing to show", () => {
		const { dialog } = renderDialog({ diff: null });
		expect(within(dialog).getByText("No changed files found")).toBeInTheDocument();
		expect(within(dialog).getByText("No changes found")).toBeInTheDocument();
		cleanup();
		renderDialog({ diff: { files: [], summary: "Nothing to merge" } as WorktreeDiff });
		expect(screen.getByText("Nothing to merge")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Expand all" })).toBeNull();
	});
});
