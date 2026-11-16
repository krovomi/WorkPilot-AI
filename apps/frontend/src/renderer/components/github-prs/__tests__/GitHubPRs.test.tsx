/**
 * The pull requests view: connected or not, the list and its filters, and
 * the page of the PR picked, whose every action goes to that PR.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../../stores/project-store";
import type { PRDetail } from "../components/PRDetail";
import type { PRData } from "../hooks/useGitHubPRs";

const hook = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../hooks/useGitHubPRs", () => ({
	useGitHubPRs: (projectId: string | undefined, options: unknown) => {
		hook.value.calledWith = [projectId, options];
		return hook.value;
	},
}));

type DetailProps = React.ComponentProps<typeof PRDetail>;
const detail = vi.hoisted(() => ({ props: null as DetailProps | null }));
vi.mock("../components/PRDetail", () => ({
	PRDetail: (props: DetailProps) => {
		detail.props = props;
		return <div>Detail of #{props.pr.number}</div>;
	},
}));

import { GitHubPRs } from "../GitHubPRs";

const pr = (number: number, login = "ana") =>
	({
		number,
		title: `PR ${number}`,
		body: "",
		author: { login },
		headRefName: `b${number}`,
		additions: 1,
		deletions: 1,
		createdAt: `2026-11-0${number}T00:00:00Z`,
		updatedAt: `2026-11-0${number}T00:00:00Z`,
	}) as PRData;

function connected(fields: Record<string, unknown> = {}) {
	hook.value = {
		prs: [pr(1), pr(2, "bob")],
		isLoading: false,
		isLoadingMore: false,
		isLoadingPRDetails: false,
		error: null,
		selectedPR: null,
		selectedPRNumber: null,
		reviewResult: null,
		reviewProgress: null,
		startedAt: null,
		isReviewing: false,
		previousReviewResult: null,
		isConnected: true,
		repoFullName: "o/r",
		hasMore: false,
		selectPR: vi.fn(),
		refresh: vi.fn(),
		loadMore: vi.fn(),
		runReview: vi.fn(),
		runFollowupReview: vi.fn(),
		checkNewCommits: vi.fn().mockResolvedValue({ hasNewCommits: true }),
		cancelReview: vi.fn(),
		postReview: vi.fn().mockResolvedValue(true),
		postComment: vi.fn().mockResolvedValue(true),
		mergePR: vi.fn(),
		assignPR: vi.fn(),
		markReviewPosted: vi.fn(),
		getReviewStateForPR: vi.fn(() => null),
		...fields,
	};
	return hook.value as Record<string, ReturnType<typeof vi.fn>>;
}

describe("GitHubPRs", () => {
	beforeEach(() => {
		detail.props = null;
		useProjectStore.setState({
			projects: [{ id: "p1", name: "One" }] as never,
			selectedProjectId: "p1",
		});
	});

	it("asks to connect GitHub, with the reason when there is one", async () => {
		connected({ isConnected: false, error: "Token expired" });
		const onOpenSettings = vi.fn();
		const { rerender } = render(<GitHubPRs onOpenSettings={onOpenSettings} />);
		expect(screen.getByText("GitHub Not Connected")).toBeInTheDocument();
		expect(screen.getByText("Token expired")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /Settings/ }));
		expect(onOpenSettings).toHaveBeenCalled();

		connected({ isConnected: false });
		rerender(<GitHubPRs />);
		expect(
			screen.getByText("Connect your GitHub account to view and review pull requests."),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /Settings/ })).toBeNull();
	});

	it("shows nothing of a project that is not open", () => {
		connected();
		useProjectStore.setState({ selectedProjectId: "gone" });
		render(<GitHubPRs isActive />);
		expect(hook.value.calledWith).toEqual([undefined, { isActive: true }]);
		expect(screen.getByText("GitHub Not Connected")).toBeInTheDocument();
	});

	it("lists the PRs with the repository, a count and a refresh", async () => {
		const api = connected();
		render(<GitHubPRs />);
		expect(hook.value.calledWith).toEqual(["p1", { isActive: false }]);
		expect(screen.getByRole("link", { name: /o\/r/ })).toHaveAttribute(
			"href",
			"https://github.com/o/r/pulls",
		);
		expect(screen.getByText("2 open")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(api.refresh).toHaveBeenCalled();
		expect(screen.getByText("Select a pull request to view details")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /PR 2/ }));
		expect(api.selectPR).toHaveBeenCalledWith(2);
	});

	it("refreshes once at a time", () => {
		connected({ repoFullName: null, isLoading: true });
		render(<GitHubPRs />);
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
	});

	it("filters the list it shows", async () => {
		connected();
		render(<GitHubPRs />);
		await userEvent.type(screen.getByPlaceholderText("Search PRs..."), "zzz");
		expect(screen.getByText("No results found")).toBeInTheDocument();
	});

	it("sends every action of the open PR to that PR", async () => {
		const selected = pr(2);
		const api = connected({
			selectedPR: selected,
			selectedPRNumber: 2,
			getReviewStateForPR: vi.fn(() => ({ newCommitsCheck: { hasNewCommits: true } })),
		});
		const getPRLogs = vi.fn().mockResolvedValue(null);
		Object.assign(globalThis.electronAPI, { github: { ...globalThis.electronAPI.github, getPRLogs } });
		render(<GitHubPRs isActive />);
		expect(screen.getByText("Detail of #2")).toBeInTheDocument();

		const props = detail.props as DetailProps;
		expect(props.projectId).toBe("p1");
		expect(props.isActive).toBe(true);
		expect(props.initialNewCommitsCheck).toEqual({ hasNewCommits: true });

		props.onRunReview();
		props.onRunFollowupReview();
		props.onCancelReview();
		await props.onCheckNewCommits();
		await props.onPostReview(["f1"], { forceApprove: true });
		await props.onPostComment("LGTM");
		props.onMergePR("squash");
		props.onAssignPR("bob");
		await props.onGetLogs();
		await props.onMarkReviewPosted?.(2);

		expect(api.runReview).toHaveBeenCalledWith(2);
		expect(api.runFollowupReview).toHaveBeenCalledWith(2);
		expect(api.cancelReview).toHaveBeenCalledWith(2);
		expect(api.checkNewCommits).toHaveBeenCalledWith(2);
		expect(api.postReview).toHaveBeenCalledWith(2, ["f1"], { forceApprove: true });
		expect(api.postComment).toHaveBeenCalledWith(2, "LGTM");
		expect(api.mergePR).toHaveBeenCalledWith(2, "squash");
		expect(api.assignPR).toHaveBeenCalledWith(2, "bob");
		expect(getPRLogs).toHaveBeenCalledWith("p1", 2);
		expect(api.markReviewPosted).toHaveBeenCalledWith(2);
	});

	it("starts the page of a PR with no stored commit check", () => {
		connected({ selectedPR: pr(1), selectedPRNumber: 1 });
		render(<GitHubPRs />);
		expect(detail.props?.initialNewCommitsCheck).toBeNull();
	});
});
