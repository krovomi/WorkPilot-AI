/** @vitest-environment jsdom */
/**
 * The two import dialogs: the Azure DevOps import dialog of the project
 * settings (pick, then import as tasks), and the confirmation the board shows
 * when Jira issues or Azure DevOps work items are dropped on a column.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import type { AzureDevOpsWorkItem } from "../../../../shared/types/integrations";
import { AzureDevOpsImportModal } from "../../azure-devops-import";
import { ImportConfirmDialog } from "../../azure-devops-import/ImportConfirmDialog";

const api = {
	checkAzureDevOpsConnection: vi.fn(),
	getAzureDevOpsWorkItems: vi.fn(),
	importAzureDevOpsWorkItems: vi.fn(),
};

const workItem = (id: number, over: Partial<AzureDevOpsWorkItem> = {}): AzureDevOpsWorkItem => ({
	id,
	title: `Item ${id}`,
	state: "New",
	workItemType: "Bug",
	tags: [],
	...over,
});

const ITEMS = [workItem(11, { priority: 1 }), workItem(12, { workItemType: "Task" }), workItem(13)];

const onOpenChange = vi.fn();
const onImportComplete = vi.fn();

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	onOpenChange.mockReset();
	onImportComplete.mockReset();
	localStorage.clear();
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = api;
	api.checkAzureDevOpsConnection.mockResolvedValue({ success: true, data: { connected: true, projectName: "Fabrikam" } });
	api.getAzureDevOpsWorkItems.mockResolvedValue({ success: true, data: ITEMS });
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const row = (id: string) => screen.getByRole("button", { name: new RegExp(`^${id}`) });
const importButton = () => screen.getByRole("button", { name: /^(Import \d+ items?|Importing\.\.\.)$/ });

function modal(props: Partial<Parameters<typeof AzureDevOpsImportModal>[0]> = {}) {
	return render(
		<AzureDevOpsImportModal
			projectId="p1"
			open
			onOpenChange={onOpenChange}
			onImportComplete={onImportComplete}
			{...props}
		/>,
	);
}

async function openModal(props: Partial<Parameters<typeof AzureDevOpsImportModal>[0]> = {}) {
	const view = modal(props);
	await screen.findByText("Item 11");
	return view;
}

describe("AzureDevOpsImportModal", () => {
	it("reads nothing while closed", async () => {
		modal({ open: false });
		await act(() => new Promise((r) => setTimeout(r, 10)));
		expect(api.checkAzureDevOpsConnection).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("lists the work items once, with the project, and filters them", async () => {
		await openModal();
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("Import Azure DevOps Work Items")).toBeInTheDocument();
		expect(dialog).toHaveTextContent("Project: Fabrikam");
		expect(within(row("#11")).getByText("P1")).toBeInTheDocument();
		expect(within(row("#12")).getByText("Task").className).toContain("text-blue-500");
		expect(within(row("#12")).queryByText(/^P\d/)).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Search work items..."), { target: { value: "item 13" } });
		expect(screen.queryByText("Item 11")).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Search work items..."), { target: { value: "nothing" } });
		expect(screen.getByText("Try adjusting your filters")).toBeInTheDocument();
		await act(() => new Promise((r) => setTimeout(r, 10)));
		expect(api.checkAzureDevOpsConnection).toHaveBeenCalledTimes(1);
		expect(api.getAzureDevOpsWorkItems).toHaveBeenCalledTimes(1);
		expect(api.getAzureDevOpsWorkItems).toHaveBeenCalledWith("p1", undefined, undefined, 1000);
	});

	it("says what is wrong when Azure DevOps is not connected, and offers only to cancel", async () => {
		api.checkAzureDevOpsConnection.mockResolvedValue({ success: true, data: { connected: false } });
		modal();
		expect(await screen.findByRole("alert")).toHaveTextContent("Azure DevOps not configured");
		expect(screen.queryByLabelText("Search work items...")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Import/ })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("shows no project line and an empty list as such", async () => {
		api.checkAzureDevOpsConnection.mockResolvedValue({ success: true, data: { connected: true } });
		api.getAzureDevOpsWorkItems.mockResolvedValue({ success: true, data: [] });
		modal();
		expect(await screen.findByText("No work items found")).toBeInTheDocument();
		expect(screen.getByRole("dialog")).not.toHaveTextContent("Project:");
		expect(importButton()).toBeDisabled();
	});

	it("imports the selected items, with the review requirement, then moves on", async () => {
		await openModal();
		fireEvent.click(row("#11"));
		expect(importButton()).toHaveTextContent("Import 1 item");
		fireEvent.click(row("#13"));
		fireEvent.click(screen.getByRole("checkbox", { name: "Require human review before coding" }));
		let answer!: (value: unknown) => void;
		api.importAzureDevOpsWorkItems.mockReturnValue(new Promise((r) => (answer = r)));
		fireEvent.click(importButton());
		expect(api.importAzureDevOpsWorkItems).toHaveBeenCalledWith("p1", [11, 13], { requireReviewBeforeCoding: true });
		expect(importButton()).toHaveTextContent("Importing...");
		expect(importButton()).toBeDisabled();
		expect(screen.getByRole("checkbox", { name: "Require human review before coding" })).toBeDisabled();

		vi.useFakeTimers();
		await act(async () => answer({ success: true, data: { success: true, imported: 2, failed: 1 } }));
		expect(screen.getByRole("status")).toHaveTextContent("Import Successful!");
		expect(screen.getByRole("status")).toHaveTextContent("Imported 2 work items. 1 failed.");
		expect(screen.queryByLabelText("Search work items...")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Import \d/ })).not.toBeInTheDocument();
		expect(onImportComplete).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(1500));
		expect(onImportComplete).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("imports without options when no review is asked, and says nothing failed", async () => {
		await openModal({ onImportComplete: undefined });
		fireEvent.click(row("#12"));
		api.importAzureDevOpsWorkItems.mockResolvedValue({ success: true, data: { success: true, imported: 1, failed: 0 } });
		fireEvent.click(importButton());
		expect(await screen.findByRole("status")).toHaveTextContent("Imported 1 work item.");
		expect(screen.getByRole("status")).not.toHaveTextContent("failed");
		expect(api.importAzureDevOpsWorkItems).toHaveBeenCalledWith("p1", [12], undefined);
	});

	it("says why an import did not happen", async () => {
		await openModal();
		fireEvent.click(row("#11"));
		const cases: [() => void, string][] = [
			[() => api.importAzureDevOpsWorkItems.mockResolvedValueOnce({ success: false, error: "Refused" }), "Refused"],
			[
				() =>
					api.importAzureDevOpsWorkItems.mockResolvedValueOnce({
						success: true,
						data: { success: false, imported: 0, failed: 1, errors: ["Field missing"] },
					}),
				"Field missing",
			],
			[
				() =>
					api.importAzureDevOpsWorkItems.mockResolvedValueOnce({
						success: true,
						data: { success: false, imported: 0, failed: 1 },
					}),
				"Import failed",
			],
			[() => api.importAzureDevOpsWorkItems.mockResolvedValueOnce({ success: false }), "Import failed"],
			[() => api.importAzureDevOpsWorkItems.mockRejectedValueOnce(new Error("IPC gone")), "IPC gone"],
			[() => api.importAzureDevOpsWorkItems.mockRejectedValueOnce("gone"), "Unknown error"],
		];
		for (const [arrange, message] of cases) {
			arrange();
			fireEvent.click(importButton());
			await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(message));
			expect(importButton()).toBeEnabled();
			expect(screen.queryByRole("status")).not.toBeInTheDocument();
		}
	});

	it("starts afresh after closing, and never moves on once closed", async () => {
		const { rerender } = await openModal();
		fireEvent.click(row("#11"));
		fireEvent.change(screen.getByLabelText("Search work items..."), { target: { value: "item" } });
		api.importAzureDevOpsWorkItems.mockResolvedValue({ success: true, data: { success: true, imported: 1, failed: 0 } });
		fireEvent.click(importButton());
		await screen.findByRole("status");
		vi.useFakeTimers();
		fireEvent.click(screen.getByRole("button", { name: "Done" }));
		act(() => vi.advanceTimersByTime(2000));
		expect(onImportComplete).not.toHaveBeenCalled();
		vi.useRealTimers();

		rerender(<AzureDevOpsImportModal projectId="p1" open={false} onOpenChange={onOpenChange} />);
		rerender(<AzureDevOpsImportModal projectId="p1" open onOpenChange={onOpenChange} />);
		expect(await screen.findByLabelText("Search work items...")).toHaveValue("");
		expect(row("#11")).toHaveAttribute("aria-pressed", "false");
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("clears an import error on closing, and stops waiting when it goes away", async () => {
		await openModal();
		fireEvent.click(row("#11"));
		api.importAzureDevOpsWorkItems.mockResolvedValueOnce({ success: false, error: "Refused" });
		fireEvent.click(importButton());
		await screen.findByRole("alert");
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();

		api.importAzureDevOpsWorkItems.mockResolvedValueOnce({ success: true, data: { success: true, imported: 1, failed: 0 } });
		fireEvent.click(row("#12"));
		fireEvent.click(importButton());
		await screen.findByRole("status");
		vi.useFakeTimers();
		cleanup();
		act(() => vi.advanceTimersByTime(2000));
		expect(onImportComplete).not.toHaveBeenCalled();
	});

	it("reads Azure DevOps again on refresh, from an empty search and selection", async () => {
		await openModal();
		fireEvent.click(row("#11"));
		fireEvent.change(screen.getByLabelText("Search work items..."), { target: { value: "item" } });
		api.getAzureDevOpsWorkItems.mockResolvedValueOnce({ success: true, data: [workItem(20)] });
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("Item 20")).toBeInTheDocument();
		expect(screen.getByLabelText("Search work items...")).toHaveValue("");
		expect(importButton()).toBeDisabled();
	});
});

describe("ImportConfirmDialog", () => {
	const onConfirm = vi.fn();
	const onCancel = vi.fn();

	beforeEach(() => {
		onConfirm.mockReset();
		onCancel.mockReset();
	});

	function confirm(props: Partial<Parameters<typeof ImportConfirmDialog>[0]> = {}) {
		return render(
			<ImportConfirmDialog
				open
				onOpenChange={onOpenChange}
				workItems={ITEMS}
				targetColumn="backlog"
				isImporting={false}
				onConfirm={onConfirm}
				onCancel={onCancel}
				source="azure-devops"
				{...props}
			/>,
		);
	}

	it("names Azure DevOps work items by number, and the target column", () => {
		confirm();
		const dialog = screen.getByRole("alertdialog");
		expect(within(dialog).getByText("Import 3 work item(s)")).toBeInTheDocument();
		expect(dialog).toHaveTextContent("The following items will be imported into the Backlog column.");
		expect(within(dialog).getByText("#11")).toBeInTheDocument();
		expect(within(dialog).getByText("Task").className).toContain("text-blue-500");
	});

	it("names Jira issues by their key, in Jira's words", () => {
		confirm({
			source: "jira",
			workItems: [{ id: "PROJ-1", title: "Login fails", state: "To Do", workItemType: "Story", tags: [] }],
			targetColumn: null,
		});
		const dialog = screen.getByRole("alertdialog");
		expect(within(dialog).getByText("Import 1 issue(s)")).toBeInTheDocument();
		expect(within(dialog).getByText("PROJ-1")).toBeInTheDocument();
		expect(within(dialog).queryByText("#PROJ-1")).not.toBeInTheDocument();
		expect(within(dialog).getByText("Story").className).toContain("text-success");
		expect(dialog).toHaveTextContent("into the column.");
	});

	it("confirms with or without the review requirement", () => {
		confirm();
		fireEvent.click(screen.getByRole("button", { name: "Import 3 item(s)" }));
		expect(onConfirm).toHaveBeenLastCalledWith(false);
		fireEvent.click(screen.getByRole("checkbox", { name: "Require human review before coding" }));
		fireEvent.click(screen.getByRole("button", { name: "Import 3 item(s)" }));
		expect(onConfirm).toHaveBeenLastCalledWith(true);
	});

	it("cancels, closing the side panel too", () => {
		confirm();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onCancel).toHaveBeenCalledTimes(1);
		cleanup();
		confirm({ onCancel: undefined });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledTimes(2);
	});

	it("cannot be closed or confirmed while importing", () => {
		confirm({ isImporting: true });
		expect(screen.getByRole("button", { name: "Importing..." })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
		expect(onOpenChange).not.toHaveBeenCalled();
		cleanup();
		confirm();
		fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
