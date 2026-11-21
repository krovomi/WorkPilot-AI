/**
 * Completing a task that still has a worktree: what will be deleted, and what to do when it fails.
 *
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { WorktreeCleanupDialog } from "../WorktreeCleanupDialog";

function renderDialog(props: Partial<Parameters<typeof WorktreeCleanupDialog>[0]> = {}) {
	const onConfirm = vi.fn();
	const onOpenChange = vi.fn();
	render(
		<WorktreeCleanupDialog
			open
			taskTitle="Add login page"
			isProcessing={false}
			onOpenChange={onOpenChange}
			onConfirm={onConfirm}
			{...props}
		/>,
	);
	return { onConfirm, onOpenChange };
}

describe("WorktreeCleanupDialog", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
	});

	it("names the task, the worktree path and the warning, then confirms", () => {
		const { onConfirm } = renderDialog({ worktreePath: "/repo/.worktrees/042" });
		const dialog = screen.getByRole("alertdialog");

		expect(screen.getByText("Complete Task")).toBeTruthy();
		expect(screen.getByText('"Add login page"').tagName).toBe("STRONG");
		expect(dialog.textContent).toContain(
			"still has an isolated workspace (worktree).",
		);
		expect(screen.getByText(/the worktree and its associated branch will be deleted/)).toBeTruthy();
		expect(screen.getByText("/repo/.worktrees/042")).toBeTruthy();
		expect(screen.getByText(/Make sure you have merged or saved/)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Delete Worktree & Complete" }));
		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it("shows the failure and offers to try again", () => {
		const { onConfirm } = renderDialog({ error: "worktree is locked" });

		expect(screen.getByText("Cleanup Failed")).toBeTruthy();
		expect(screen.getByText("worktree is locked")).toBeTruthy();
		expect(screen.queryByText(/Make sure you have merged/)).toBeNull();
		expect(screen.queryByText("/repo/.worktrees/042")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it("locks both buttons while it works", () => {
		renderDialog({ isProcessing: true });
		expect(
			(screen.getByRole("button", { name: "Completing..." }) as HTMLButtonElement).disabled,
		).toBe(true);
		expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it("closes on cancel", () => {
		const { onOpenChange, onConfirm } = renderDialog();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onConfirm).not.toHaveBeenCalled();
	});
});
