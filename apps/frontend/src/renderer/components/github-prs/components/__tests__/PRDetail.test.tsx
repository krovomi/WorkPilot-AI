/**
 * The page of one PR: what it posts to GitHub and when, the fork workflows it
 * approves, GitHub's live merge view and the branch update, the logs, and a
 * fresh page for each PR. The child views are stand-ins that show what the
 * page hands them; each has its own tests.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../../shared/i18n";
import type { PRData, PRReviewResult } from "../../hooks/useGitHubPRs";
import { PRDetail } from "../PRDetail";

vi.mock("../../../jev/JevStatus", () => ({ JevStatus: () => null }));
vi.mock("../PRHeader", () => ({
	PRHeader: ({ pr }: { pr: PRData }) => <h1>{pr.title}</h1>,
}));
vi.mock("../ReviewStatusTree", () => ({
	ReviewStatusTree: (p: { status: string; postedCount: number }) => (
		<>
			<output data-testid="status">{p.status}</output>
			<output data-testid="posted-count">{p.postedCount}</output>
		</>
	),
}));
vi.mock("../ReviewFindings", () => ({
	ReviewFindings: (p: {
		selectedIds: Set<string>;
		postedIds: Set<string>;
		onSelectionChange: (ids: Set<string>) => void;
	}) => (
		<>
			<output data-testid="selected">{[...p.selectedIds].join(",")}</output>
			<output data-testid="posted">{[...p.postedIds].join(",")}</output>
			<button type="button" onClick={() => p.onSelectionChange(new Set())}>
				unselect all
			</button>
		</>
	),
}));
vi.mock("../PRLogs", () => ({
	PRLogs: (p: { logs: unknown; isStreaming: boolean }) => (
		<output data-testid="logs">
			{JSON.stringify({ logs: p.logs, streaming: p.isStreaming })}
		</output>
	),
}));
vi.mock("../DeepContextInsights", () => ({
	DeepContextInsights: () => <p>deep context</p>,
}));
vi.mock("../../../QualityScorePanel", () => ({
	QualityScorePanel: ({ score }: { score: { overall: number } }) => (
		<p>quality {score.overall}</p>
	),
}));

const t = (key: string, options?: Record<string, unknown>) =>
	i18n.t(`common:prReview.${key}`, options ?? {});

type Props = React.ComponentProps<typeof PRDetail>;

const pr = (number: number, overrides: Partial<PRData> = {}): PRData =>
	({
		number,
		title: `PR ${number}`,
		body: "What it does",
		state: "open",
		author: { login: "ana" },
		headRefName: "feature",
		baseRefName: "main",
		additions: 1,
		deletions: 1,
		changedFiles: 1,
		assignees: [],
		files: [],
		createdAt: "2026-11-01T00:00:00Z",
		updatedAt: "2026-11-01T00:00:00Z",
		htmlUrl: `https://github.com/o/r/pull/${number}`,
		...overrides,
	}) as PRData;

const finding = (id: string, severity: "low" | "medium" | "high" | "critical") => ({
	id,
	severity,
	category: "quality" as const,
	title: id,
	description: id,
	file: "a.ts",
	line: 1,
	fixable: false,
});

const review = (overrides: Partial<PRReviewResult> = {}): PRReviewResult => ({
	prNumber: 7,
	repo: "o/r",
	success: true,
	findings: [],
	summary: "All good",
	overallStatus: "comment",
	reviewedAt: "2026-11-15T00:00:00Z",
	...overrides,
});

const github = () => globalThis.electronAPI.github as unknown as Record<string, ReturnType<typeof vi.fn>>;

function setup(overrides: Partial<Props> = {}) {
	const props: Props = {
		pr: pr(7),
		projectId: "p1",
		reviewResult: null,
		previousReviewResult: null,
		reviewProgress: null,
		startedAt: null,
		isReviewing: false,
		initialNewCommitsCheck: null,
		onRunReview: vi.fn(),
		onRunFollowupReview: vi.fn(),
		onCheckNewCommits: vi.fn().mockResolvedValue({ hasNewCommits: false, newCommitCount: 0 }),
		onCancelReview: vi.fn(),
		onPostReview: vi.fn().mockResolvedValue(true),
		onPostComment: vi.fn().mockResolvedValue(true),
		onMergePR: vi.fn(),
		onGetLogs: vi.fn().mockResolvedValue(null),
		onMarkReviewPosted: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
	const view = render(<PRDetail {...props} />);
	const rerender = (more: Partial<Props>) => {
		Object.assign(props, more);
		view.rerender(<PRDetail {...props} />);
	};
	return { props, rerender, unmount: view.unmount };
}

const status = () => screen.getByTestId("status").textContent;
/** Lets pending promises settle. */
const settle = () => act(() => Promise.resolve());

describe("PRDetail", () => {
	beforeEach(() => {
		Object.assign(globalThis.electronAPI, {
			github: {
				...globalThis.electronAPI.github,
				getWorkflowsAwaitingApproval: vi.fn().mockResolvedValue({
					awaiting_approval: 0,
					workflow_runs: [],
					can_approve: false,
				}),
				approveWorkflow: vi.fn().mockResolvedValue(true),
				checkMergeReadiness: vi.fn().mockResolvedValue({ blockers: [] }),
				updatePRBranch: vi.fn().mockResolvedValue({ success: true }),
			},
			quality: { analyzePRQuality: vi.fn().mockResolvedValue({ overall: 88 }) },
		});
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows the PR's description, or says it has none", () => {
		const { rerender } = setup();
		expect(screen.getByText("PR 7")).toBeInTheDocument();
		expect(screen.getByText("What it does")).toBeInTheDocument();
		rerender({ pr: pr(7, { body: "" }) });
		expect(screen.getByText(t("noDescription"))).toBeInTheDocument();
		expect(status()).toBe("not_reviewed");
	});

	it("shows how far a running review is", () => {
		setup({
			isReviewing: true,
			reviewProgress: { phase: "analyzing", prNumber: 7, progress: 40, message: "Reading files" },
		});
		expect(status()).toBe("reviewing");
		expect(screen.getByText("Reading files")).toBeInTheDocument();
		expect(screen.getByText("40%")).toBeInTheDocument();
	});

	it("names the verdict, and why a review failed", () => {
		const { rerender } = setup({ reviewResult: review({ overallStatus: "comment" }) });
		expect(screen.getByText(t("commented"))).toBeInTheDocument();
		rerender({ reviewResult: review({ overallStatus: "request_changes" }) });
		expect(screen.getByText(t("changesRequested"))).toBeInTheDocument();
		rerender({ reviewResult: review({ success: false, error: "gh: timeout" }) });
		expect(screen.getByText(t("reviewFailed"))).toBeInTheDocument();
		expect(screen.getByText("gh: timeout")).toBeInTheDocument();
	});

	it("shows what a follow-up resolved, and runs it again", async () => {
		const { props } = setup({
			reviewResult: review({
				isFollowupReview: true,
				findings: [finding("c", "high"), finding("d", "low")],
				resolvedFindings: ["a", "b"],
				unresolvedFindings: ["c"],
				newFindingsSinceLastReview: ["d"],
			}),
		});
		expect(screen.getByText(t("followupReviewDetails"))).toBeInTheDocument();
		expect(screen.getByText(t("resolved", { count: 2 }))).toBeInTheDocument();
		expect(screen.getByText(t("stillOpen", { count: 1 }))).toBeInTheDocument();
		expect(screen.getByText(t("newIssue", { count: 1 }))).toBeInTheDocument();
		await userEvent.click(screen.getByTitle(t("rerunFollowup")));
		expect(props.onRunFollowupReview).toHaveBeenCalledTimes(1);
		expect(status()).toBe("followup_issues_remain");
	});

	it("shows no count a follow-up did not report, and waits for a running review", () => {
		setup({ isReviewing: true, reviewResult: review({ isFollowupReview: true }) });
		expect(screen.queryByText(/resolved|still open|new issue/)).toBeNull();
		expect(screen.getByTitle(t("rerunFollowup"))).toBeDisabled();
	});

	it("shows the deeper codebase context when the review has one", () => {
		setup({ reviewResult: review({ deepContext: { contextAvailable: true } as never }) });
		expect(screen.getByText("deep context")).toBeInTheDocument();
	});

	describe("posting the review", () => {
		it("selects every finding not yet posted, and posts the selection", async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			const { props } = setup({
				reviewResult: review({
					findings: [finding("a", "low"), finding("b", "medium"), finding("c", "high")],
					postedFindingIds: ["c"],
					reviewedCommitSha: "abc",
				}),
				initialNewCommitsCheck: { hasNewCommits: false, newCommitCount: 0, lastReviewedCommit: "abc" },
			});
			expect(screen.getByTestId("selected").textContent).toBe("a,b");
			expect(props.onCheckNewCommits).not.toHaveBeenCalled();

			fireEvent.click(screen.getByRole("button", { name: t("postFindings", { count: 2 }) }));
			await settle();
			expect(props.onPostReview).toHaveBeenCalledWith(["a", "b"]);
			expect(screen.getByText(t("postedFindings", { count: 2 }))).toBeInTheDocument();
			expect(screen.getByTestId("posted").textContent).toBe("c,a,b");
			expect(screen.getByTestId("selected").textContent).toBe("");
			expect(screen.getByTestId("posted-count").textContent).toBe("3");

			// The message goes after three seconds.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});
			expect(screen.queryByText(t("postedFindings", { count: 2 }))).toBeNull();
		});

		it("keeps the selection when GitHub refuses the post", async () => {
			const { props } = setup({
				reviewResult: review({ findings: [finding("a", "high")] }),
				onPostReview: vi.fn().mockResolvedValue(false),
			});
			await userEvent.click(screen.getByRole("button", { name: t("postFindings", { count: 1 }) }));
			expect(props.onPostReview).toHaveBeenCalledWith(["a"]);
			expect(screen.getByTestId("selected").textContent).toBe("a");
			expect(screen.queryByText(t("postedFindings", { count: 1 }))).toBeNull();
			expect(
				screen.getByRole("button", { name: t("postFindings", { count: 1 }) }),
			).toBeEnabled();
		});

		it("approves a clean PR with its LOW findings as suggestions, then offers the merge", async () => {
			const { props, rerender } = setup({
				reviewResult: review({ findings: [finding("a", "low")], overallStatus: "approve" }),
			});
			await userEvent.click(screen.getByRole("button", { name: "unselect all" }));
			const approve = screen.getByRole("button", { name: /Approve PR/ });
			expect(approve).toHaveTextContent(t("suggestions", { count: 1 }));
			await userEvent.click(approve);
			expect(props.onPostReview).toHaveBeenCalledWith(["a"], { forceApprove: true });
			expect(screen.queryByRole("button", { name: /Approve PR/ })).toBeNull();

			await userEvent.click(screen.getByRole("button", { name: t("merge") }));
			expect(props.onMergePR).toHaveBeenCalledWith("squash");

			// A refused approval leaves the button.
			rerender({ pr: pr(8), reviewResult: review({ overallStatus: "approve" }), onPostReview: vi.fn().mockResolvedValue(false) });
			await userEvent.click(screen.getByRole("button", { name: t("autoApprovePR") }));
			expect(screen.getByRole("button", { name: t("autoApprovePR") })).toBeInTheDocument();
		});

		it("approves a PR the review calls ready despite a MEDIUM finding", async () => {
			const { props } = setup({
				reviewResult: review({
					findings: [finding("a", "medium")],
					overallStatus: "approve",
					summary: "Fine to ship",
				}),
			});
			await userEvent.click(screen.getByRole("button", { name: t("approve") }));
			const body = vi.mocked(props.onPostComment).mock.calls[0][0];
			expect(body).toBe(
				"## ✅ WorkPilot AI PR Review - APPROVED\n\nFine to ship\n\n---\n*This approval was generated by WorkPilot AI.*",
			);
		});

		it("posts a blocking verdict that has no finding as a status comment", async () => {
			const { props, rerender } = setup({
				reviewResult: review({ overallStatus: "request_changes", summary: "Tests fail" }),
			});
			await userEvent.click(screen.getByRole("button", { name: t("postBlockedStatus") }));
			expect(vi.mocked(props.onPostComment).mock.calls[0][0]).toContain("Tests fail");
			expect(screen.getByText(t("blockedStatusPosted"))).toBeInTheDocument();
			expect(props.onMarkReviewPosted).toHaveBeenCalledWith(7);
			expect(screen.queryByRole("button", { name: t("postBlockedStatus") })).toBeNull();

			for (const onPostComment of [
				vi.fn().mockResolvedValue(false),
				vi.fn().mockRejectedValue(new Error("offline")),
			]) {
				const markPosted = vi.fn();
				rerender({ pr: pr(props.pr.number + 1), onPostComment, onMarkReviewPosted: markPosted });
				await userEvent.click(screen.getByRole("button", { name: t("postBlockedStatus") }));
				expect(screen.getByText(t("failedPostBlockedStatus"))).toBeInTheDocument();
				expect(screen.queryByText(t("blockedStatusPosted"))).toBeNull();
				expect(markPosted).not.toHaveBeenCalled();
			}
		});
	});

	describe("one page per PR", () => {
		it("forgets what was posted on the previous PR", async () => {
			const { rerender } = setup({
				reviewResult: review({ overallStatus: "request_changes" }),
			});
			await userEvent.click(screen.getByRole("button", { name: t("postBlockedStatus") }));
			expect(screen.getByText(t("blockedStatusPosted"))).toBeInTheDocument();
			rerender({ pr: pr(8) });
			expect(screen.queryByText(t("blockedStatusPosted"))).toBeNull();
			expect(screen.getByRole("button", { name: t("postBlockedStatus") })).toBeInTheDocument();
		});

		it("does not show on the next PR a post that ends after leaving", async () => {
			let finish: (ok: boolean) => void = () => undefined;
			const { rerender } = setup({
				reviewResult: review({ findings: [finding("a", "high")] }),
				onPostReview: vi.fn(() => new Promise<boolean>((r) => { finish = r; })),
			});
			await userEvent.click(screen.getByRole("button", { name: t("postFindings", { count: 1 }) }));
			rerender({ pr: pr(8), reviewResult: review({ findings: [finding("b", "high")] }) });
			await act(async () => finish(true));
			expect(screen.queryByText(t("postedFindings", { count: 1 }))).toBeNull();
			expect(screen.getByTestId("selected").textContent).toBe("b");
			expect(
				screen.getByRole("button", { name: t("postFindings", { count: 1 }) }),
			).toBeEnabled();
		});
	});

	describe("new commits", () => {
		it("checks for commits after the reviewed one, once", async () => {
			const onCheckNewCommits = vi.fn().mockResolvedValue({
				hasNewCommits: true,
				newCommitCount: 1,
				hasCommitsAfterPosting: true,
				lastReviewedCommit: "abc",
			});
			setup({
				reviewResult: review({ reviewedCommitSha: "abc", hasPostedFindings: true }),
				onCheckNewCommits,
			});
			await waitFor(() => expect(status()).toBe("ready_for_followup"));
			expect(onCheckNewCommits).toHaveBeenCalledTimes(1);
		});

		it("trusts a check it was given, and skips a review with no commit", () => {
			const onCheckNewCommits = vi.fn();
			const { rerender } = setup({
				reviewResult: review({ reviewedCommitSha: "abc" }),
				initialNewCommitsCheck: { hasNewCommits: false, newCommitCount: 0 },
				onCheckNewCommits,
			});
			rerender({ reviewResult: review() });
			expect(onCheckNewCommits).not.toHaveBeenCalled();
			// A newer check from the store replaces the page's.
			rerender({
				reviewResult: review({ hasPostedFindings: true }),
				initialNewCommitsCheck: {
					hasNewCommits: true,
					newCommitCount: 2,
					hasCommitsAfterPosting: true,
				},
			});
			expect(status()).toBe("ready_for_followup");
		});

		it("drops a check that ends after the page closed", async () => {
			let finish: (v: unknown) => void = () => undefined;
			const { unmount } = setup({
				reviewResult: review({ reviewedCommitSha: "abc" }),
				onCheckNewCommits: vi.fn(() => new Promise((r) => { finish = r; })) as never,
			});
			unmount();
			await act(async () => finish({ hasNewCommits: true, newCommitCount: 1 }));
		});
	});

	describe("fork workflows", () => {
		const runs = [
			{ id: 1, name: "push", workflow_name: "CI", html_url: "https://github.com/o/r/actions/runs/1" },
			{ id: 2, name: "push", workflow_name: "Lint", html_url: "https://github.com/o/r/actions/runs/2" },
		];

		it("lists the runs waiting for a maintainer, for this project's PR", async () => {
			github().getWorkflowsAwaitingApproval.mockResolvedValue({
				awaiting_approval: 2,
				workflow_runs: runs,
				can_approve: true,
			});
			const open = vi.spyOn(window, "open").mockReturnValue(null);
			setup();
			expect(await screen.findByText(t("workflowsAwaitingApproval", { count: 2 }))).toBeInTheDocument();
			// The project used to be left empty, so the card never showed.
			expect(github().getWorkflowsAwaitingApproval).toHaveBeenCalledWith("p1", 7);
			expect(screen.getByText("CI")).toBeInTheDocument();

			await userEvent.click(screen.getAllByRole("button", { name: t("viewOnGitHub") })[0]);
			expect(open).toHaveBeenCalledWith(runs[0].html_url, "_blank");

			await userEvent.click(screen.getAllByRole("button", { name: t("approveWorkflow") })[1]);
			expect(github().approveWorkflow).toHaveBeenCalledWith("p1", 2);
			expect(github().getWorkflowsAwaitingApproval).toHaveBeenCalledTimes(2);

			// One refused run does not stop the others.
			github().approveWorkflow.mockRejectedValueOnce(new Error("403"));
			await userEvent.click(screen.getByRole("button", { name: t("approveAllWorkflows") }));
			expect(github().approveWorkflow).toHaveBeenCalledWith("p1", 1);
			expect(github().approveWorkflow).toHaveBeenLastCalledWith("p1", 2);
			expect(github().getWorkflowsAwaitingApproval).toHaveBeenCalledTimes(3);
			open.mockRestore();
		});

		it("does not reload the runs when GitHub refuses an approval", async () => {
			github().getWorkflowsAwaitingApproval.mockResolvedValue({
				awaiting_approval: 1,
				workflow_runs: [runs[0]],
				can_approve: true,
			});
			github().approveWorkflow.mockResolvedValue(false);
			setup();
			await userEvent.click(await screen.findByRole("button", { name: t("approveWorkflow") }));
			expect(github().getWorkflowsAwaitingApproval).toHaveBeenCalledTimes(1);
			expect(screen.queryByRole("button", { name: t("approveAllWorkflows") })).toBeNull();
		});

		it("shows nothing when the runs cannot be read", async () => {
			github().getWorkflowsAwaitingApproval.mockRejectedValue(new Error("offline"));
			setup();
			await settle();
			expect(screen.queryByText(t("blockedByWorkflows"))).toBeNull();
		});
	});

	describe("GitHub's live merge view", () => {
		const readyReview = review({ overallStatus: "approve", hasPostedFindings: true });

		it("warns when GitHub contradicts a ready verdict, and updates the branch", async () => {
			github().checkMergeReadiness.mockResolvedValue({
				blockers: ["Branch is behind main", "Branch is behind main"],
				isBehind: true,
			});
			setup({ reviewResult: readyReview });
			expect(await screen.findAllByText("Branch is behind main")).toHaveLength(2);
			expect(github().checkMergeReadiness).toHaveBeenCalledWith("p1", 7);

			github().checkMergeReadiness.mockResolvedValue({ blockers: [] });
			await userEvent.click(screen.getByRole("button", { name: t("updateBranch") }));
			expect(github().updatePRBranch).toHaveBeenCalledWith("p1", 7);
			expect(screen.getByText(t("branchUpdated"))).toBeInTheDocument();
			// Read again: the warning was about this branch. It used to stay.
			await waitFor(() => expect(screen.queryByText("Branch is behind main")).toBeNull());
			expect(github().checkMergeReadiness).toHaveBeenCalledTimes(2);
		});

		it("says why the branch could not be updated", async () => {
			github().checkMergeReadiness.mockResolvedValue({ blockers: ["Behind"], isBehind: true });
			const outcomes = [
				() => github().updatePRBranch.mockResolvedValueOnce({ success: false, error: "conflict" }),
				() => github().updatePRBranch.mockResolvedValueOnce({ success: false }),
				() => github().updatePRBranch.mockRejectedValueOnce(new Error("offline")),
				() => github().updatePRBranch.mockRejectedValueOnce("gone"),
			];
			const messages = ["conflict", t("branchUpdateFailed"), "offline", "gone"];
			setup({ reviewResult: readyReview });
			const button = await screen.findByRole("button", { name: t("updateBranch") });
			for (const [i, outcome] of outcomes.entries()) {
				outcome();
				await userEvent.click(button);
				expect(await screen.findByText(messages[i])).toBeInTheDocument();
				expect(button).toBeEnabled();
			}
			expect(github().checkMergeReadiness).toHaveBeenCalledTimes(1);
		});

		it("clears the branch message after three seconds", async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			github().checkMergeReadiness.mockResolvedValue({ blockers: ["Behind"], isBehind: true });
			setup({ reviewResult: readyReview });
			fireEvent.click(await screen.findByRole("button", { name: t("updateBranch") }));
			await settle();
			expect(screen.getByText(t("branchUpdated"))).toBeInTheDocument();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});
			expect(screen.queryByText(t("branchUpdated"))).toBeNull();
		});

		it("stays quiet when nothing contradicts the verdict", async () => {
			github().checkMergeReadiness.mockResolvedValue({ blockers: ["Behind"] });
			const { rerender } = setup({
				reviewResult: review({ findings: [finding("a", "high")] }),
			});
			await settle();
			// Not a ready verdict: the warning has nothing to contradict.
			expect(status()).toBe("needs_attention");
			expect(screen.queryByText("Behind")).toBeNull();

			github().checkMergeReadiness.mockRejectedValue(new Error("offline"));
			rerender({ pr: pr(8), reviewResult: readyReview });
			await settle();
			expect(screen.queryByText("Behind")).toBeNull();
		});

		it("does not ask GitHub without a project", () => {
			setup({ projectId: "", reviewResult: readyReview });
			expect(github().checkMergeReadiness).not.toHaveBeenCalled();
		});
	});

	describe("logs", () => {
		it("loads the logs once, when opened", async () => {
			const onGetLogs = vi.fn().mockResolvedValue({ is_followup: true, phases: {} });
			setup({ reviewResult: review(), onGetLogs });
			expect(onGetLogs).not.toHaveBeenCalled();
			const trigger = screen.getByRole("button", { name: new RegExp(t("reviewLogs")) });
			await userEvent.click(trigger);
			expect(await screen.findByText(t("followup"))).toBeInTheDocument();
			await userEvent.click(trigger);
			await userEvent.click(trigger);
			expect(onGetLogs).toHaveBeenCalledTimes(1);
		});

		it("names an initial review's logs, and survives logs it cannot read", async () => {
			const onGetLogs = vi.fn().mockResolvedValue({ is_followup: false, phases: {} });
			const { rerender } = setup({ reviewResult: review(), onGetLogs });
			await userEvent.click(screen.getByRole("button", { name: new RegExp(t("reviewLogs")) }));
			expect(await screen.findByText(t("initial"))).toBeInTheDocument();

			rerender({ pr: pr(8), onGetLogs: vi.fn().mockRejectedValue(new Error("gone")) });
			await userEvent.click(screen.getByRole("button", { name: new RegExp(t("reviewLogs")) }));
			await waitFor(() =>
				expect(screen.getByTestId("logs").textContent).toBe(
					JSON.stringify({ logs: null, streaming: false }),
				),
			);
		});

		it("streams the logs during a review, and reads them once more at the end", async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
			const onGetLogs = vi
				.fn()
				.mockResolvedValueOnce({ is_followup: false, n: 1 })
				.mockRejectedValueOnce(new Error("busy"))
				.mockResolvedValue({ is_followup: false, n: 3 });
			const { rerender } = setup({ isReviewing: true, onGetLogs });
			await settle();
			expect(screen.getByTestId("logs").textContent).toContain('"streaming":true');
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});
			expect(onGetLogs.mock.calls.length).toBeGreaterThanOrEqual(3);

			const before = onGetLogs.mock.calls.length;
			rerender({ isReviewing: false, reviewResult: review() });
			await settle();
			expect(onGetLogs).toHaveBeenCalledTimes(before + 1);
			// The final read failing is logged, and the interval is gone.
			rerender({ isReviewing: true });
			onGetLogs.mockRejectedValueOnce(new Error("busy"));
			rerender({ isReviewing: false });
			await settle();
			expect(error).toHaveBeenCalledWith("Failed to fetch final logs:", expect.any(Error));
			const settled = onGetLogs.mock.calls.length;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});
			expect(onGetLogs).toHaveBeenCalledTimes(settled);
			error.mockRestore();
		});
	});

	describe("code quality", () => {
		it("scores the changed files once per reviewed PR", async () => {
			const files = [{ path: "a.ts", additions: 1, deletions: 0, status: "modified" }];
			const { rerender } = setup({ pr: pr(7, { files }), reviewResult: review() });
			expect(await screen.findByText("quality 88")).toBeInTheDocument();
			expect(globalThis.electronAPI.quality.analyzePRQuality).toHaveBeenCalledWith(7, ["a.ts"], "p1");
			rerender({ reviewResult: review({ summary: "again" }) });
			// The same files, read again into a new list.
			rerender({ pr: pr(7, { files: [...files] }) });
			expect(globalThis.electronAPI.quality.analyzePRQuality).toHaveBeenCalledTimes(1);
		});

		it("logs a score that could not be computed", async () => {
			const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
			vi.mocked(globalThis.electronAPI.quality.analyzePRQuality).mockRejectedValue(new Error("no python"));
			setup({ pr: pr(7, { files: [{ path: "a.ts" }] as never }), reviewResult: review() });
			await waitFor(() =>
				expect(error).toHaveBeenCalledWith("Failed to analyze quality:", expect.any(Error)),
			);
			error.mockRestore();
		});
	});
});
