/**
 * The page of one GitLab MR: running a review, posting its findings, the
 * follow-up once commits arrive, approving and merging, and a fresh page for
 * each MR. The findings list is a stand-in that shows what the page hands
 * it; it has its own tests.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import i18n from "../../../../../shared/i18n";
import type {
	GitLabMergeRequest,
	GitLabMRReviewFinding,
	GitLabMRReviewResult,
	GitLabNewCommitsCheck,
} from "../../../../../shared/types";
import { MRDetail } from "../MRDetail";

vi.mock("../../../jev/JevStatus", () => ({ JevStatus: () => null }));
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

const t = (key: string, options?: Record<string, unknown>) =>
	i18n.t(`gitlab:${key}`, options ?? {});

const MR: GitLabMergeRequest = {
	id: 1007,
	iid: 7,
	title: "Add the export",
	description: "Exports the board as CSV.",
	state: "opened",
	sourceBranch: "feat/export",
	targetBranch: "main",
	author: { username: "dana" },
	assignees: [{ username: "lee" }, { username: "sam" }],
	labels: ["backend", "csv"],
	webUrl: "https://gitlab.example/group/app/-/merge_requests/7",
	createdAt: "2026-11-01T09:00:00Z",
	updatedAt: "2026-11-01T09:00:00Z",
	mergeStatus: "can_be_merged",
};

const finding = (
	id: string,
	severity: GitLabMRReviewFinding["severity"],
): GitLabMRReviewFinding => ({
	id,
	severity,
	category: "quality",
	title: id,
	description: "",
	file: "a.ts",
	line: 1,
	fixable: false,
});

const review = (
	over: Partial<GitLabMRReviewResult> = {},
): GitLabMRReviewResult => ({
	mrIid: 7,
	project: "group/app",
	success: true,
	findings: [finding("a", "critical"), finding("b", "high"), finding("c", "low")],
	summary: "Two blockers.",
	overallStatus: "request_changes",
	reviewedAt: "2026-11-02T10:00:00Z",
	reviewedCommitSha: "abcdef1234567",
	...over,
});

function setup(
	over: Partial<React.ComponentProps<typeof MRDetail>> = {},
	check: GitLabNewCommitsCheck = { hasNewCommits: false },
) {
	const props: React.ComponentProps<typeof MRDetail> = {
		projectId: "p1",
		mr: MR,
		reviewResult: null,
		reviewProgress: null,
		isReviewing: false,
		onRunReview: vi.fn(),
		onRunFollowupReview: vi.fn(),
		onCheckNewCommits: vi.fn(async () => check),
		onCancelReview: vi.fn(),
		onPostReview: vi.fn(async () => true),
		onMergeMR: vi.fn(async () => true),
		onApproveMR: vi.fn(async () => true),
		...over,
	};
	const view = render(<MRDetail {...props} />);
	return { props, ...view, user: userEvent.setup() };
}

const banner = (status: string) =>
	screen.getByText(t(`mrReview.status.${status}`));

describe("MRDetail header", () => {
	it("shows the MR as GitLab knows it", () => {
		setup();

		expect(screen.getByText(t("mergeRequests.states.opened"))).toBeInTheDocument();
		expect(screen.getByText("!7")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Add the export" })).toBeInTheDocument();
		expect(
			screen.getByRole("link", {
				name: i18n.t("common:accessibility.openOnGitLabAriaLabel"),
			}),
		).toHaveAttribute("href", MR.webUrl);
		expect(screen.getByText("dana")).toBeInTheDocument();
		expect(screen.getByText("feat/export → main")).toBeInTheDocument();
		expect(screen.getByText("lee, sam")).toBeInTheDocument();
		expect(
			screen.getByText(t("mrReview.mergeStatus.can_be_merged")),
		).toBeInTheDocument();
		expect(screen.getByText("Exports the board as CSV.")).toBeInTheDocument();
		expect(screen.getByText("csv")).toBeInTheDocument();
	});

	it("passes an unknown merge status through and leaves empty parts out", () => {
		setup({
			mr: {
				...MR,
				state: "merged",
				description: undefined,
				assignees: [],
				labels: [],
				mergeStatus: "ci_still_running",
			},
		});

		expect(screen.getByText(t("mergeRequests.states.merged"))).toBeInTheDocument();
		expect(screen.getByText("ci_still_running")).toBeInTheDocument();
		expect(screen.getByText(t("mrReview.noDescription"))).toBeInTheDocument();
		expect(screen.queryByText(t("mrReview.labels"))).not.toBeInTheDocument();
	});

	it("leaves the merge status out when GitLab gave none", () => {
		setup({ mr: { ...MR, mergeStatus: "" } });
		expect(
			screen.queryByText(t("mrReview.mergeStatus.can_be_merged")),
		).not.toBeInTheDocument();
	});
});

describe("MRDetail review", () => {
	it("asks for a first review and runs it", async () => {
		const { props, user } = setup();

		expect(banner("not_reviewed")).toBeInTheDocument();
		expect(screen.getByText(t("mrReview.status.notReviewedDesc"))).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: t("mrReview.runReview") }));
		expect(props.onRunReview).toHaveBeenCalledTimes(1);
		expect(props.onCheckNewCommits).not.toHaveBeenCalled();
	});

	it("shows a running review's progress and cancels it", async () => {
		const { props, user } = setup({
			isReviewing: true,
			reviewProgress: {
				phase: "analyzing",
				mrIid: 7,
				progress: 40,
				message: "Reading the diff",
			},
		});

		expect(screen.getByRole("button", { name: t("mrReview.reviewing") })).toBeDisabled();
		expect(screen.getByText("Reading the diff")).toBeInTheDocument();
		expect(screen.getByText("40%")).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: i18n.t("common:buttons.cancel") }),
		);
		expect(props.onCancelReview).toHaveBeenCalledTimes(1);
	});

	it("says when the review failed", () => {
		setup({ reviewResult: review({ success: false }) });
		expect(screen.getByText(t("mrReview.reviewFailed"))).toBeInTheDocument();
		expect(banner("not_reviewed")).toBeInTheDocument();
	});

	it("shows the result, its verdict and the commit it read", () => {
		setup({ reviewResult: review() });

		expect(screen.getByText(t("mrReview.aiReviewResult"))).toBeInTheDocument();
		expect(
			screen.getByText(t("mrReview.overallStatus.requestChanges")),
		).toBeInTheDocument();
		expect(screen.getByText("Two blockers.")).toBeInTheDocument();
		expect(
			screen.getByText(new RegExp(t("mrReview.atCommit", { sha: "abcdef1" }))),
		).toBeInTheDocument();
		expect(banner("needs_attention")).toBeInTheDocument();
		expect(
			screen.getByText(t("mrReview.status.needsPosting", { count: 2 })),
		).toBeInTheDocument();
	});

	it("selects the blocking findings for posting", () => {
		setup({ reviewResult: review() });
		expect(screen.getByTestId("selected")).toHaveTextContent("a,b");
		expect(
			screen.getByRole("button", { name: t("mrReview.postCount", { count: 2 }) }),
		).toBeInTheDocument();
	});

	it("offers no post button once nothing is selected", async () => {
		const { user } = setup({ reviewResult: review() });
		await user.click(screen.getByRole("button", { name: "unselect all" }));
		expect(
			screen.queryByRole("button", { name: /mrReview|Post/ }),
		).not.toBeInTheDocument();
	});
});

describe("MRDetail posting", () => {
	it("posts the selection, then waits for the author", async () => {
		const { props, user } = setup({ reviewResult: review() });

		await user.click(
			screen.getByRole("button", { name: t("mrReview.postCount", { count: 2 }) }),
		);

		expect(props.onPostReview).toHaveBeenCalledWith(["a", "b"]);
		expect(screen.getByTestId("posted")).toHaveTextContent("a,b");
		expect(screen.getByTestId("selected")).toHaveTextContent("");
		expect(
			screen.getByText(t("mrReview.postedCount", { count: 2 })),
		).toBeInTheDocument();
		await waitFor(() => expect(props.onCheckNewCommits).toHaveBeenCalled());
		expect(banner("waiting_for_changes")).toBeInTheDocument();
		expect(
			screen.getByText(t("mrReview.status.waiting", { count: 2 })),
		).toBeInTheDocument();
	});

	it("drops the success line after a few seconds", async () => {
		vi.useFakeTimers();
		try {
			setup({ reviewResult: review() });
			await act(async () => {
				screen
					.getByRole("button", { name: t("mrReview.postCount", { count: 2 }) })
					.click();
			});
			const line = t("mrReview.postedCount", { count: 2 });
			expect(screen.getByText(line)).toBeInTheDocument();
			await act(async () => {
				vi.advanceTimersByTime(3000);
			});
			expect(screen.queryByText(line)).not.toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the selection when GitLab refused the post", async () => {
		const { user } = setup({
			reviewResult: review(),
			onPostReview: vi.fn(async () => false),
		});

		await user.click(
			screen.getByRole("button", { name: t("mrReview.postCount", { count: 2 }) }),
		);

		expect(screen.getByTestId("posted")).toHaveTextContent("");
		expect(screen.getByTestId("selected")).toHaveTextContent("a,b");
		expect(banner("needs_attention")).toBeInTheDocument();
	});

	it("shows the post as running until GitLab answers", async () => {
		let answer: (ok: boolean) => void = () => undefined;
		const { user } = setup({
			reviewResult: review(),
			onPostReview: () =>
				new Promise<boolean>((resolve) => {
					answer = resolve;
				}),
		});

		await user.click(
			screen.getByRole("button", { name: t("mrReview.postCount", { count: 2 }) }),
		);
		expect(screen.getByRole("button", { name: t("mrReview.posting") })).toBeDisabled();
		await act(async () => answer(true));
		expect(
			screen.queryByRole("button", { name: t("mrReview.posting") }),
		).not.toBeInTheDocument();
	});

	it("keeps the follow-up it found after a first post", async () => {
		const { props, user } = setup(
			{ reviewResult: review() },
			{ hasNewCommits: true, newCommitCount: 3 },
		);

		await user.click(
			screen.getByRole("button", { name: t("mrReview.postCount", { count: 2 }) }),
		);
		const followup = t("mrReview.followupWithCommits", { count: 3 });
		await screen.findByRole("button", { name: followup });
		// A delayed re-check from before the post used to wipe this answer.
		await act(() => new Promise((resolve) => setTimeout(resolve, 600)));

		expect(screen.getByRole("button", { name: followup })).toBeInTheDocument();
		expect(banner("ready_for_followup")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: followup }));
		await user.click(
			screen.getByRole("button", { name: t("mrReview.runFollowup") }),
		);
		expect(props.onRunFollowupReview).toHaveBeenCalledTimes(2);
	});
});

describe("MRDetail new commits", () => {
	const posted = review({ hasPostedFindings: true, postedFindingIds: ["a"] });

	it("checks for new commits once findings are on GitLab", async () => {
		const { props } = setup({ reviewResult: posted });

		await waitFor(() => expect(props.onCheckNewCommits).toHaveBeenCalled());
		expect(banner("waiting_for_changes")).toBeInTheDocument();
	});

	it("does not check a review that read no commit", () => {
		const { props } = setup({
			reviewResult: { ...posted, reviewedCommitSha: undefined },
		});
		expect(props.onCheckNewCommits).not.toHaveBeenCalled();
	});

	it("reads a failed check as nothing new", async () => {
		const failing = vi.fn(async (): Promise<GitLabNewCommitsCheck> => {
			throw new Error("offline");
		});
		setup({ reviewResult: posted, onCheckNewCommits: failing });

		await waitFor(() => expect(failing).toHaveBeenCalled());
		expect(banner("waiting_for_changes")).toBeInTheDocument();
	});

	it("counts no commit when the check gave no count", async () => {
		setup({ reviewResult: posted }, { hasNewCommits: true });
		expect(
			await screen.findByRole("button", {
				name: t("mrReview.followupWithCommits", { count: 0 }),
			}),
		).toBeInTheDocument();
	});

	it("shows the review button while a follow-up runs", async () => {
		const { rerender, props } = setup(
			{ reviewResult: posted },
			{ hasNewCommits: true, newCommitCount: 1 },
		);
		await screen.findByRole("button", {
			name: t("mrReview.followupWithCommits", { count: 1 }),
		});

		rerender(<MRDetail {...props} isReviewing />);
		expect(
			screen.getAllByRole("button", { name: t("mrReview.reviewing") }),
		).toHaveLength(2);
	});
});

describe("MRDetail follow-up result", () => {
	it("counts what the follow-up resolved, left open and found", () => {
		setup({
			reviewResult: review({
				isFollowupReview: true,
				overallStatus: "comment",
				resolvedFindings: ["x", "y"],
				unresolvedFindings: ["a"],
				reviewedCommitSha: undefined,
			}),
		});

		expect(screen.getByText(t("mrReview.followupReviewResult"))).toBeInTheDocument();
		expect(screen.getByText(t("mrReview.overallStatus.comment"))).toBeInTheDocument();
		expect(
			screen.getByText(t("mrReview.resolvedCount", { count: 2 })),
		).toBeInTheDocument();
		expect(
			screen.getByText(t("mrReview.stillOpenCount", { count: 1 })),
		).toBeInTheDocument();
		expect(
			screen.queryByText(t("mrReview.newIssueCount", { count: 0 })),
		).not.toBeInTheDocument();
		expect(banner("followup_issues_remain")).toBeInTheDocument();
		expect(screen.queryByText(/abcdef1/)).not.toBeInTheDocument();
	});
});

describe("MRDetail approve and merge", () => {
	const ready = review({ overallStatus: "approve", findings: [] });

	it("approves and squash-merges an MR the review clears", async () => {
		const { props, user } = setup({ reviewResult: ready });

		// The verdict badge and the button share their word.
		expect(screen.getAllByText(t("mrReview.overallStatus.approve"))).toHaveLength(2);
		await user.click(screen.getByRole("button", { name: t("mrReview.approve") }));
		await user.click(screen.getByRole("button", { name: t("mrReview.merge") }));

		expect(props.onApproveMR).toHaveBeenCalledTimes(1);
		expect(props.onMergeMR).toHaveBeenCalledWith("squash");
	});

	it("shows each action as running until GitLab answers", async () => {
		let approved: (ok: boolean) => void = () => undefined;
		let merged: (ok: boolean) => void = () => undefined;
		const { user } = setup({
			reviewResult: ready,
			onApproveMR: () =>
				new Promise<boolean>((resolve) => {
					approved = resolve;
				}),
			onMergeMR: () =>
				new Promise<boolean>((resolve) => {
					merged = resolve;
				}),
		});

		await user.click(screen.getByRole("button", { name: t("mrReview.approve") }));
		await user.click(screen.getByRole("button", { name: t("mrReview.merge") }));
		expect(screen.getByRole("button", { name: t("mrReview.approving") })).toBeDisabled();
		expect(screen.getByRole("button", { name: t("mrReview.merging") })).toBeDisabled();

		await act(async () => {
			approved(true);
			merged(false);
		});
		expect(screen.getByRole("button", { name: t("mrReview.approve") })).toBeEnabled();
		expect(screen.getByRole("button", { name: t("mrReview.merge") })).toBeEnabled();
	});

	it("offers neither on an MR that is no longer open", () => {
		setup({ reviewResult: ready, mr: { ...MR, state: "merged" } });
		expect(
			screen.queryByRole("button", { name: t("mrReview.merge") }),
		).not.toBeInTheDocument();
	});

	it("offers neither while the review has blockers", () => {
		setup({ reviewResult: review() });
		expect(
			screen.queryByRole("button", { name: t("mrReview.approve") }),
		).not.toBeInTheDocument();
	});
});

describe("MRDetail across MRs", () => {
	it("starts a fresh page for another MR", async () => {
		const { props, rerender, user } = setup({ reviewResult: review() });
		await user.click(
			screen.getByRole("button", { name: t("mrReview.postCount", { count: 2 }) }),
		);
		expect(screen.getByTestId("posted")).toHaveTextContent("a,b");

		rerender(
			<MRDetail
				{...props}
				mr={{ ...MR, id: 1008, iid: 8, title: "Another" }}
				reviewResult={review({ mrIid: 8 })}
			/>,
		);

		expect(screen.getByTestId("posted")).toHaveTextContent("");
		expect(banner("needs_attention")).toBeInTheDocument();
		expect(
			screen.queryByText(t("mrReview.postedCount", { count: 2 })),
		).not.toBeInTheDocument();
	});
});
