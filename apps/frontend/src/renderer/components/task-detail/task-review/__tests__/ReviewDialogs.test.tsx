/**
 * The review card's confirmations and notes: closing a task against its
 * Definition of Done, discarding a build, the conflicts of a merge preview,
 * and the staged changes with their suggested commit message.
 */

import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../../shared/i18n";
import type {
	MergeConflict,
	Task,
	WorktreeStatus,
} from "../../../../../shared/types";
import { CompletionDialog } from "../CompletionDialog";
import { ConflictDetailsDialog } from "../ConflictDetailsDialog";
import { DiscardDialog } from "../DiscardDialog";
import { StagedSuccessMessage } from "../StagedSuccessMessage";

const TASK = { id: "t1", title: "Task one", metadata: {} } as unknown as Task;

afterEach(async () => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

describe("CompletionDialog", () => {
	it("closes a task that has its pull request and its visual proof", async () => {
		const onConfirm = vi.fn();
		render(
			<CompletionDialog
				open
				task={{
					...TASK,
					prUrl: "https://x/pr/1",
					metadata: { visualProof: { screenshots: ["a.png"] } },
				} as unknown as Task}
				isCompleting={false}
				onOpenChange={vi.fn()}
				onConfirm={onConfirm}
			/>,
		);
		const dialog = screen.getByRole("alertdialog");
		expect(within(dialog).getByText("PR created")).toBeInTheDocument();
		expect(within(dialog).getByText("Visual proof captured")).toBeInTheDocument();
		expect(within(dialog).queryByText(/Some items are missing/)).toBeNull();
		await userEvent.click(within(dialog).getByRole("button", { name: "Close task" }));
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it("warns of what is missing but still closes, in the app's language", async () => {
		await i18n.changeLanguage("fr");
		const onConfirm = vi.fn();
		const onOpenChange = vi.fn();
		const { rerender } = render(
			<CompletionDialog open task={TASK} isCompleting={false} onOpenChange={onOpenChange} onConfirm={onConfirm} />,
		);
		const dialog = screen.getByRole("alertdialog");
		expect(within(dialog).getAllByText(/^Aucune|^Pas de/).length).toBe(2);
		const buttons = within(dialog).getAllByRole("button");
		await userEvent.click(buttons[buttons.length - 1]);
		expect(onConfirm).toHaveBeenCalled();
		await userEvent.click(buttons[0]);
		expect(onOpenChange).toHaveBeenCalledWith(false);
		rerender(
			<CompletionDialog open task={TASK} isCompleting onOpenChange={onOpenChange} onConfirm={onConfirm} />,
		);
		for (const button of within(screen.getByRole("alertdialog")).getAllByRole("button")) {
			expect(button).toBeDisabled();
		}
	});
});

describe("DiscardDialog", () => {
	const status = { exists: true, filesChanged: 4, additions: 12, deletions: 5 } as WorktreeStatus;

	it("shows what will be lost and discards it", async () => {
		const onDiscard = vi.fn();
		render(
			<DiscardDialog open task={TASK} worktreeStatus={status} isDiscarding={false} onOpenChange={vi.fn()} onDiscard={onDiscard} />,
		);
		const dialog = screen.getByRole("alertdialog");
		expect(within(dialog).getByText('"Task one"')).toBeInTheDocument();
		expect(within(dialog).getByText("4")).toBeInTheDocument();
		expect(within(dialog).getByText("+12")).toBeInTheDocument();
		expect(within(dialog).getByText("-5")).toBeInTheDocument();
		await userEvent.click(within(dialog).getByRole("button", { name: "Discard Build" }));
		expect(onDiscard).toHaveBeenCalledTimes(1);
	});

	it("without a worktree shows no numbers, and is busy while discarding", () => {
		render(
			<DiscardDialog
				open
				task={TASK}
				worktreeStatus={{ exists: true } as WorktreeStatus}
				isDiscarding
				onOpenChange={vi.fn()}
				onDiscard={vi.fn()}
			/>,
		);
		const dialog = screen.getByRole("alertdialog");
		expect(within(dialog).getByText("+0")).toBeInTheDocument();
		expect(within(dialog).getByRole("button", { name: "Discarding..." })).toBeDisabled();
		cleanup();
		render(
			<DiscardDialog open task={TASK} worktreeStatus={null} isDiscarding={false} onOpenChange={vi.fn()} onDiscard={vi.fn()} />,
		);
		expect(screen.queryByText("Files changed:")).toBeNull();
	});
});

describe("ConflictDetailsDialog", () => {
	const conflict = (overrides: Partial<MergeConflict>): MergeConflict => ({
		file: "src/a.ts",
		location: "line 10",
		tasks: ["t1"],
		severity: "low",
		canAutoMerge: false,
		reason: "Both edited",
		...overrides,
	});

	function preview(conflicts: MergeConflict[], autoMergeable = 0) {
		return {
			files: [],
			conflicts,
			summary: { totalFiles: 2, conflictFiles: conflicts.length, totalConflicts: conflicts.length, autoMergeable },
		};
	}

	it("lists each conflict with its severity, place, reason and strategy", async () => {
		await i18n.changeLanguage("fr");
		render(
			<ConflictDetailsDialog
				open
				mergePreview={preview(
					[
						conflict({ severity: "critical", strategy: "keep both" }),
						conflict({ file: "b.ts", severity: "medium", canAutoMerge: true, location: "", reason: "" }),
						conflict({ file: "c.ts", severity: "none" }),
						conflict({ file: "d.ts", severity: "unknown" as never }),
					],
					1,
				)}
				stageOnly={false}
				onOpenChange={vi.fn()}
				onMerge={vi.fn()}
			/>,
		);
		const dialog = screen.getByRole("alertdialog");
		expect(within(dialog).getByText(/4 conflits potentiels/)).toBeInTheDocument();
		expect(within(dialog).getByText("critique")).toBeInTheDocument();
		expect(within(dialog).getByText("moyenne")).toBeInTheDocument();
		expect(within(dialog).getByText("aucune")).toBeInTheDocument();
		expect(within(dialog).getByText("unknown")).toBeInTheDocument();
		expect(within(dialog).getByText("keep both")).toBeInTheDocument();
		expect(within(dialog).getAllByText("line 10")).toHaveLength(3);
	});

	it("merges or stages with AI from the dialog, closing it first", async () => {
		const onMerge = vi.fn();
		const onOpenChange = vi.fn();
		const { rerender } = render(
			<ConflictDetailsDialog open mergePreview={preview([conflict({})])} stageOnly={false} onOpenChange={onOpenChange} onMerge={onMerge} />,
		);
		await userEvent.click(screen.getByRole("button", { name: "Merge with AI" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onMerge).toHaveBeenCalledTimes(1);
		rerender(
			<ConflictDetailsDialog open mergePreview={preview([conflict({})])} stageOnly onOpenChange={onOpenChange} onMerge={onMerge} />,
		);
		expect(screen.getByRole("button", { name: "Stage with AI Merge" })).toBeInTheDocument();
	});

	it("says there is no conflict", () => {
		render(
			<ConflictDetailsDialog open mergePreview={null} stageOnly={false} onOpenChange={vi.fn()} onMerge={vi.fn()} />,
		);
		expect(screen.getByText("No conflicts detected")).toBeInTheDocument();
		expect(screen.getByText(/0 potential conflicts/)).toBeInTheDocument();
	});
});

describe("StagedSuccessMessage", () => {
	it("shows the staging result and the next steps without a suggestion", () => {
		render(<StagedSuccessMessage stagedSuccess="3 files staged" />);
		expect(screen.getByText("3 files staged")).toBeInTheDocument();
		expect(screen.getByText("git diff --staged")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
	});

	it("copies the edited commit message, then says it was copied for two seconds", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
		render(<StagedSuccessMessage stagedSuccess="Staged" suggestedCommitMessage="feat: add login" />);
		const message = screen.getByRole("textbox");
		await user.clear(message);
		await user.type(message, "feat: sign in");
		await user.click(screen.getByRole("button", { name: "Copy" }));
		expect(writeText).toHaveBeenCalledWith("feat: sign in");
		expect(screen.getByRole("button", { name: "Copied!" })).toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
	});

	it("cannot copy an emptied message, and survives a refused clipboard", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
		render(<StagedSuccessMessage stagedSuccess="Staged" suggestedCommitMessage="feat: x" />);
		await userEvent.click(screen.getByRole("button", { name: "Copy" }));
		expect(error).toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
		await userEvent.clear(screen.getByRole("textbox"));
		expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
		expect(writeText).toHaveBeenCalledTimes(1);
	});
});
