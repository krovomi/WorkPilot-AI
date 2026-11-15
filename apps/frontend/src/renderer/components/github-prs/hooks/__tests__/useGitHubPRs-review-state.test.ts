/**
 * The review state the GitHub PR hook shows for the selected PR comes live
 * from the review store: a review started, its progress and its result reach
 * the detail panel as they happen.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { usePRReviewStore } from "../../../../stores/github";
import { useGitHubPRs } from "../useGitHubPRs";

const pr = (number: number) => ({ number, title: `PR ${number}` });
const INITIAL = usePRReviewStore.getState();
const reviews = () => usePRReviewStore.getState();

let github: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
	usePRReviewStore.setState(INITIAL, true);
	github = {
		checkGitHubConnection: vi.fn().mockResolvedValue({
			success: true,
			data: { connected: true, repoFullName: "acme/shop" },
		}),
		listPRs: vi.fn().mockResolvedValue({ prs: [pr(1), pr(2)], hasNextPage: false }),
		getPRReviewsBatch: vi.fn().mockResolvedValue({}),
		getPR: vi.fn().mockResolvedValue(null),
		getPRReview: vi.fn().mockResolvedValue(null),
		runPRReview: vi.fn(),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = { github };
});

it("follows a review of the selected PR as it runs and ends", async () => {
	const { result } = renderHook(() => useGitHubPRs("p1"));
	await waitFor(() => expect(result.current.prs).toHaveLength(2));
	act(() => result.current.selectPR(1));

	act(() => result.current.runReview(1));
	expect(github.runPRReview).toHaveBeenCalledWith("p1", 1);
	expect(result.current).toMatchObject({ isReviewing: true, activePRReviews: [1] });

	const progress = { prNumber: 1, phase: "analyzing", progress: 50, message: "…" };
	act(() => reviews().setPRReviewProgress("p1", progress as never));
	expect(result.current.reviewProgress).toEqual(progress);

	const done = { prNumber: 1, findings: [], summary: "ok", success: true };
	act(() => reviews().setPRReviewResult("p1", done as never));
	expect(result.current).toMatchObject({ isReviewing: false, reviewResult: done, activePRReviews: [] });
});
