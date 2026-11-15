/**
 * WorkspaceStatus — the worktree of a task in review: its numbers and
 * branches, opening it in the IDE or a terminal, the merge preview (ready,
 * conflicts, behind, renamed files, already merged, superseded), the merge
 * button that fits, the pull-request-first close flow, and the progress of a
 * running merge.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	installRendererApi,
	type RendererApi,
} from "../../../../../__tests__/helpers/renderer-api";
import i18n from "../../../../../shared/i18n";
import type {
	GitConflictInfo,
	MergeProgress,
	WorktreeStatus,
} from "../../../../../shared/types";
import { useSettingsStore } from "../../../../stores/settings-store";
import { TooltipProvider } from "../../../ui/tooltip";
import { WorkspaceStatus } from "../WorkspaceStatus";

const STATUS = {
	exists: true,
	worktreePath: "/repo/.workpilot/worktrees/tasks/001",
	branch: "workpilot/001",
	baseBranch: "main",
	currentProjectBranch: "develop",
	filesChanged: 1,
	commitCount: 2,
	additions: 10,
	deletions: 3,
} as WorktreeStatus;

type Preview = NonNullable<Parameters<typeof WorkspaceStatus>[0]["mergePreview"]>;

function preview(git: Partial<GitConflictInfo> = {}, extra: Partial<Preview> = {}): Preview {
	return {
		files: ["a.ts"],
		conflicts: [],
		summary: { totalFiles: 3, conflictFiles: 0, totalConflicts: 0, autoMergeable: 0 },
		gitConflicts: {
			hasConflicts: false,
			conflictingFiles: [],
			baseBranch: "develop",
			specBranch: "workpilot/001",
			commitsBehind: 0,
			...git,
		} as GitConflictInfo,
		...extra,
	} as Preview;
}

type Props = Parameters<typeof WorkspaceStatus>[0];

function renderStatus(overrides: Partial<Props> = {}) {
	const props: Props = {
		taskId: "t1",
		worktreeStatus: STATUS,
		workspaceError: null,
		stageOnly: false,
		mergePreview: null,
		isLoadingPreview: false,
		isMerging: false,
		isDiscarding: false,
		onShowDiffDialog: vi.fn(),
		onShowDiscardDialog: vi.fn(),
		onShowConflictDialog: vi.fn(),
		onLoadMergePreview: vi.fn(),
		onStageOnlyChange: vi.fn(),
		onMerge: vi.fn(),
		...overrides,
	};
	const ui = (p: Props) => (
		<TooltipProvider>
			<WorkspaceStatus {...p} />
		</TooltipProvider>
	);
	const view = render(ui(props));
	return {
		...view,
		props,
		update: (next: Partial<Props>) => {
			Object.assign(props, next);
			view.rerender(ui(props));
		},
	};
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });

let api: RendererApi;
const settingsInitial = useSettingsStore.getState();

beforeEach(() => {
	api = installRendererApi();
});

afterEach(async () => {
	cleanup();
	api.restore();
	vi.useRealTimers();
	useSettingsStore.setState(settingsInitial, true);
	if (i18n.language !== "en") await i18n.changeLanguage("en");
});

describe("worktree", () => {
	it("shows its numbers and branches, and opens the diff and the guided review", async () => {
		const onShowGuidedReview = vi.fn();
		const { props } = renderStatus({ onShowGuidedReview });
		expect(screen.getByText("Build Ready for Review")).toBeInTheDocument();
		expect(screen.getByText("workpilot/001")).toBeInTheDocument();
		expect(screen.getByText("develop")).toBeInTheDocument();
		expect(screen.getByText(STATUS.worktreePath as string)).toBeInTheDocument();
		// One file, not "1 files".
		expect(screen.getByText("1").parentElement).toHaveTextContent(/^1 file$/);
		await userEvent.click(button("View"));
		expect(props.onShowDiffDialog).toHaveBeenCalledWith(true);
		await userEvent.click(button("Guided review"));
		expect(onShowGuidedReview).toHaveBeenCalled();
	});

	it("falls back to the base branch, then main, as the merge target", () => {
		const { update } = renderStatus({
			worktreeStatus: { ...STATUS, currentProjectBranch: undefined },
			mergePreview: preview(),
		});
		expect(button("Merge to main")).toBeInTheDocument();
		update({
			worktreeStatus: { ...STATUS, currentProjectBranch: undefined, baseBranch: undefined },
		});
		expect(button("Merge to main")).toBeInTheDocument();
		update({ worktreeStatus: STATUS });
		expect(button("Merge to develop")).toBeInTheDocument();
	});

	it("opens the worktree in the preferred IDE and terminal", async () => {
		useSettingsStore.setState({
			settings: { ...settingsInitial.settings, preferredIDE: "cursor", preferredTerminal: "warp" },
		});
		renderStatus();
		await userEvent.click(button("Open in Cursor"));
		await userEvent.click(button("Open in Warp"));
		expect(api.fn("worktreeOpenInIDE")).toHaveBeenCalledWith(STATUS.worktreePath, "cursor");
		expect(api.fn("worktreeOpenInTerminal")).toHaveBeenCalledWith(STATUS.worktreePath, "warp");
	});

	it("defaults to VS Code and the system terminal, and survives a failed launch", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		api.restore();
		api = installRendererApi({
			worktreeOpenInIDE: vi.fn(async () => {
				throw new Error("no code");
			}),
			worktreeOpenInTerminal: vi.fn(async () => {
				throw new Error("no shell");
			}),
		});
		useSettingsStore.setState({
			settings: { ...settingsInitial.settings, preferredIDE: undefined, preferredTerminal: undefined },
		});
		renderStatus();
		await userEvent.click(button("Open in VS Code"));
		await userEvent.click(button("Open in Terminal"));
		expect(api.fn("worktreeOpenInIDE")).toHaveBeenCalledWith(STATUS.worktreePath, "vscode");
		expect(error).toHaveBeenCalledTimes(2);
		error.mockRestore();
	});

	it("without a path, shows no path and no launcher", () => {
		renderStatus({ worktreeStatus: { ...STATUS, worktreePath: undefined, branch: undefined } });
		expect(screen.queryByRole("button", { name: /Open in/ })).toBeNull();
		expect(screen.queryByText("workpilot/001")).toBeNull();
	});

	it("shows the workspace error and the uncommitted changes of the project", () => {
		renderStatus({
			workspaceError: "Merge failed",
			mergePreview: preview({}, { uncommittedChanges: { hasChanges: true, files: ["x"], count: 2 } }),
		});
		expect(screen.getByText("Merge failed")).toBeInTheDocument();
		expect(screen.getByText(/2 uncommitted changes/)).toBeInTheDocument();
	});
});

describe("merge preview", () => {
	it("checks for conflicts first, then shows that it is checking", async () => {
		const { props, update } = renderStatus();
		await userEvent.click(button("Check for Conflicts"));
		expect(props.onLoadMergePreview).toHaveBeenCalled();
		update({ isLoadingPreview: true });
		expect(screen.getAllByText("Checking for conflicts...")).toHaveLength(2);
		expect(screen.queryByRole("button", { name: "Check for Conflicts" })).toBeNull();
	});

	it("a clean preview is ready to merge, refreshes, and stages on request", async () => {
		const { props, update } = renderStatus({ mergePreview: preview() });
		expect(screen.getByText("Ready to merge")).toBeInTheDocument();
		expect(screen.getByText("Ready to merge").nextSibling).toHaveTextContent("3 files");
		expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
		await userEvent.click(button("Refresh"));
		expect(props.onLoadMergePreview).toHaveBeenCalled();
		await userEvent.click(screen.getByRole("checkbox"));
		expect(props.onStageOnlyChange).toHaveBeenCalledWith(true);
		update({ stageOnly: true });
		await userEvent.click(button("Stage to develop"));
		expect(props.onMerge).toHaveBeenCalled();
		update({ isMerging: true });
		expect(button("Staging...")).toBeDisabled();
		update({ stageOnly: false });
		expect(button("Merging...")).toBeDisabled();
	});

	it("diverged branches merge with AI and show the conflicting files", async () => {
		const { props, update } = renderStatus({
			mergePreview: preview({ hasConflicts: true, conflictingFiles: ["a.ts", "b.ts"], commitsBehind: 4 }),
		});
		expect(screen.getByText("Branch Diverged")).toBeInTheDocument();
		expect(screen.getByText(/develop branch has 4 new commits/)).toBeInTheDocument();
		expect(screen.getByText(/2 files need merging/)).toBeInTheDocument();
		await userEvent.click(button("Details"));
		expect(props.onShowConflictDialog).toHaveBeenCalledWith(true);
		expect(button("Merge with AI")).toBeInTheDocument();
		update({ stageOnly: true });
		expect(button("Stage with AI Merge")).toBeInTheDocument();
		update({ isMerging: true });
		expect(button("Resolving...")).toBeInTheDocument();
	});

	it("a branch behind its base says how many commits to catch up", () => {
		renderStatus({ mergePreview: preview({ needsRebase: true, commitsBehind: 1 }) });
		expect(screen.getByText("Branch Behind")).toBeInTheDocument();
		expect(screen.getByText(/1 commit\)/)).toBeInTheDocument();
		expect(screen.getByText(/new commit since this build started/)).toBeInTheDocument();
		expect(screen.getByText(/Files may have been renamed or moved/)).toBeInTheDocument();
	});

	it("names the renames behind an AI merge", () => {
		const { update } = renderStatus({
			mergePreview: preview(
				{ needsRebase: true, commitsBehind: 2, totalRenames: 1 },
				{ summary: { totalFiles: 3, pathMappedAIMergeCount: 1 } as never },
			),
		});
		expect(screen.getByText("Files Renamed")).toBeInTheDocument();
		expect(screen.getByText(/\(1 file\)/)).toBeInTheDocument();
		expect(screen.getByText(/1 file needs AI merge due to 1 file rename\./)).toBeInTheDocument();
		update({
			mergePreview: preview(
				{ needsRebase: true, commitsBehind: 2, totalRenames: 3 },
				{ summary: { totalFiles: 3, pathMappedAIMergeCount: 2 } as never },
			),
		});
		expect(screen.getByText(/due to 3 file renames/)).toBeInTheDocument();
		update({ mergePreview: preview({ needsRebase: true, commitsBehind: 2, totalRenames: 2 }) });
		expect(screen.getByText(/2 file renames detected/)).toBeInTheDocument();
	});

	it("counts the conflicts the AI found", () => {
		const conflict = { file: "a.ts" } as never;
		const { update } = renderStatus({ mergePreview: preview({}, { conflicts: [conflict] }) });
		expect(screen.getByText(/^1\s+conflict$/)).toBeInTheDocument();
		update({ mergePreview: preview({}, { conflicts: [conflict, conflict] }) });
		expect(screen.getByText(/^2\s+conflicts$/)).toBeInTheDocument();
	});

	it("changes already in the branch are marked done instead of merged", async () => {
		const { props, update } = renderStatus({
			mergePreview: preview({ scenario: "already_merged", alreadyMergedFiles: ["a.ts", "b.ts"] }),
		});
		expect(screen.getByText("Changes already in your branch")).toBeInTheDocument();
		expect(screen.getByText("b.ts")).toBeInTheDocument();
		expect(screen.queryByRole("checkbox")).toBeNull();
		await userEvent.click(button("Mark as Done"));
		expect(props.onMerge).toHaveBeenCalled();
		update({ isMerging: true });
		expect(button("Completing...")).toBeDisabled();
		update({
			isMerging: false,
			mergePreview: preview({
				scenario: "already_merged",
				alreadyMergedFiles: ["1", "2", "3", "4", "5", "6"],
			}),
		});
		expect(screen.queryByText("Matching files:")).toBeNull();
	});

	it("superseded changes are compared or discarded", async () => {
		const { props } = renderStatus({ mergePreview: preview({ scenario: "superseded" }) });
		expect(screen.getByText("Changes superseded")).toBeInTheDocument();
		await userEvent.click(button("View Comparison"));
		expect(props.onShowConflictDialog).toHaveBeenCalledWith(true);
		await userEvent.click(button("Discard Task"));
		expect(props.onShowDiscardDialog).toHaveBeenCalledWith(true);
		expect(screen.queryByRole("button", { name: "Discard build" })).toBeNull();
	});

	it("discards the build from its icon", async () => {
		const { props } = renderStatus();
		await userEvent.click(button("Discard build"));
		expect(props.onShowDiscardDialog).toHaveBeenCalledWith(true);
	});
});

describe("pull request and closing", () => {
	it("without a close flow, offers to create or update the pull request", async () => {
		const onShowPRDialog = vi.fn();
		const { update } = renderStatus({ onShowPRDialog });
		await userEvent.click(button("Create PR"));
		expect(onShowPRDialog).toHaveBeenCalledWith(true);
		update({ isCreatingPR: true });
		expect(button("Creating PR...")).toBeDisabled();
		update({ isCreatingPR: false, existingPrUrl: "https://x/pr/1" });
		expect(button("Update PR")).toHaveAttribute("title", expect.stringMatching(/already exists/));
		update({ isCreatingPR: true });
		expect(button("Updating PR...")).toBeDisabled();
	});

	it("puts the pull request first, then closing", async () => {
		const onShowPRDialog = vi.fn();
		const onRequestComplete = vi.fn();
		const { update } = renderStatus({ onShowPRDialog, onRequestComplete });
		expect(screen.queryByRole("button", { name: "Create PR" })).toBeNull();
		await userEvent.click(button("Create the PR for review"));
		expect(onShowPRDialog).toHaveBeenCalledWith(true);
		await userEvent.click(button("Close without a PR"));
		expect(onRequestComplete).toHaveBeenCalledTimes(1);
		update({ isCreatingPR: true });
		expect(button("Create the PR for review")).toBeDisabled();
		expect(button("Close without a PR")).toBeDisabled();

		update({ isCreatingPR: false, existingPrUrl: "https://x/pr/1" });
		await userEvent.click(button("Approve & close task"));
		expect(onRequestComplete).toHaveBeenCalledTimes(2);
		expect(button("Update PR")).toBeInTheDocument();
		update({ isCompleting: true });
		expect(button("Approve & close task")).toBeDisabled();
	});

	it("a close flow without a pull request dialog still closes", async () => {
		const onRequestComplete = vi.fn();
		renderStatus({ onRequestComplete });
		await userEvent.click(button("Create the PR for review"));
		expect(onRequestComplete).not.toHaveBeenCalled();
	});
});

describe("merge progress", () => {
	const progress = (stage: MergeProgress["stage"], message: string): MergeProgress => ({
		stage,
		percent: stage === "complete" ? 100 : 40,
		message,
		details: { current_file: "a.ts" },
	});

	function listen() {
		let emit: (taskId: string, p: MergeProgress) => void = () => undefined;
		const unsubscribe = vi.fn();
		api.restore();
		api = installRendererApi({
			onMergeProgress: vi.fn((callback: typeof emit) => {
				emit = callback;
				return unsubscribe;
			}),
		});
		return { emit: (taskId: string, p: MergeProgress) => act(() => emit(taskId, p)), unsubscribe };
	}

	it("follows this task's merge, ignores another's, and hides once it is complete", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const { emit, unsubscribe } = listen();
		const { update } = renderStatus({ mergePreview: preview() });
		expect(screen.queryByText("a.ts", { exact: false })).toBeNull();

		update({ isMerging: true });
		emit("t2", progress("resolving", "Other task"));
		emit("t1", progress("resolving", "Resolving a.ts"));
		expect(screen.getByText(/Current file/)).toHaveTextContent("a.ts");
		await userEvent.click(screen.getByRole("button", { name: /View logs/ }));
		expect(screen.getByText("Resolving a.ts")).toBeInTheDocument();
		expect(screen.queryByText("Other task")).toBeNull();

		emit("t1", progress("complete", "Done"));
		update({ isMerging: false });
		expect(unsubscribe).toHaveBeenCalled();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});
		expect(screen.queryByText(/Current file/)).toBeNull();
	});

	it("hides after two seconds when the merge ends without a last word", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const { emit } = listen();
		const { update } = renderStatus({ mergePreview: preview() });
		update({ isMerging: true });
		emit("t1", progress("error", "Failed"));
		emit("t1", progress("analyzing", "Again"));
		update({ isMerging: false });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(screen.getByText(/Current file/)).toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000);
		});
		expect(screen.queryByText(/Current file/)).toBeNull();
	});

	it("hides at once when the merge took longer than the minimum, and keeps the last 500 entries", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const { emit, unsubscribe } = listen();
		const { update, unmount } = renderStatus({ mergePreview: preview() });
		update({ isMerging: true });
		for (let i = 0; i < 502; i++) emit("t1", progress("analyzing", `Step ${i}`));
		await userEvent.click(screen.getByRole("button", { name: /View logs/ }));
		expect(screen.queryByText("Step 1")).toBeNull();
		expect(screen.getByText("Step 2")).toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(600);
		});
		emit("t1", progress("error", "Broken"));
		update({ isMerging: false });
		expect(screen.queryByText(/Current file/)).toBeNull();

		update({ isMerging: true });
		unmount();
		expect(unsubscribe).toHaveBeenCalled();
	});
});
