/**
 * The GitLab merge-request hook: the connection and list it reads for a
 * project, the review state it shows for the selected MR (live, from the
 * review store), and what each MR action asks the main process for.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMRReviewStore } from "../../../../stores/gitlab";
import { useGitLabMRs } from "../useGitLabMRs";

const mr = (iid: number) => ({ iid, title: `MR ${iid}` });
const saved = (mrIid: number) => ({ mrIid, findings: [], summary: "ok" });

let api: Record<string, ReturnType<typeof vi.fn>>;
const INITIAL = useMRReviewStore.getState();
const reviews = () => useMRReviewStore.getState();

beforeEach(() => {
	useMRReviewStore.setState(INITIAL, true);
	api = {
		checkGitLabConnection: vi.fn().mockResolvedValue({
			success: true,
			data: { connected: true, projectPathWithNamespace: "acme/shop" },
		}),
		getGitLabMergeRequests: vi.fn().mockResolvedValue({ success: true, data: [mr(1), mr(2)] }),
		getGitLabMRReview: vi.fn().mockResolvedValue(null),
		runGitLabMRReview: vi.fn(),
		runGitLabMRFollowupReview: vi.fn(),
		checkGitLabMRNewCommits: vi.fn(),
		cancelGitLabMRReview: vi.fn(),
		postGitLabMRReview: vi.fn(),
		postGitLabMRNote: vi.fn(),
		mergeGitLabMR: vi.fn(),
		assignGitLabMR: vi.fn(),
		approveGitLabMR: vi.fn(),
	};
	(window as unknown as { electronAPI: typeof api }).electronAPI = api;
});

async function mounted(projectId: string | null = "p1", stateFilter?: "opened" | "merged") {
	const hook = renderHook(() => useGitLabMRs(projectId ?? undefined, stateFilter ? { stateFilter } : undefined));
	await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
	return hook;
}

describe("loading", () => {
	it("checks the connection, then lists the MRs of the filter", async () => {
		const { result } = await mounted("p1", "merged");
		expect(api.getGitLabMergeRequests).toHaveBeenCalledWith("p1", "merged");
		expect(result.current).toMatchObject({
			isConnected: true,
			projectPath: "acme/shop",
			mergeRequests: [mr(1), mr(2)],
			error: null,
		});
	});

	it("lists the open MRs by default and preloads the reviews saved on disk", async () => {
		api.getGitLabMRReview.mockImplementation(async (_p: string, iid: number) => (iid === 2 ? saved(2) : null));
		await mounted();
		expect(api.getGitLabMergeRequests).toHaveBeenCalledWith("p1", "opened");
		await waitFor(() => expect(reviews().getMRReviewState("p1", 2)?.result).toEqual(saved(2)));
		expect(reviews().getMRReviewState("p1", 1)).toBeNull();
	});

	it("does not reread a review the store already has", async () => {
		reviews().setMRReviewResult("p1", saved(1) as never);
		await mounted();
		expect(api.getGitLabMRReview).toHaveBeenCalledOnce();
		expect(api.getGitLabMRReview).toHaveBeenCalledWith("p1", 2);
	});

	it("lists nothing when GitLab is not connected", async () => {
		api.checkGitLabConnection.mockResolvedValue({ success: true, data: { connected: false } });
		const { result } = await mounted();
		expect(result.current).toMatchObject({ isConnected: false, projectPath: null, mergeRequests: [] });
		expect(api.getGitLabMergeRequests).not.toHaveBeenCalled();
	});

	it("keeps an empty list when the MRs cannot be read", async () => {
		api.getGitLabMergeRequests.mockResolvedValue({ success: false, error: "403" });
		const { result } = await mounted();
		expect(result.current.mergeRequests).toEqual([]);
	});

	it("shows why the connection check failed", async () => {
		api.checkGitLabConnection.mockResolvedValueOnce({ success: false, error: "No token" });
		const { result } = await mounted();
		expect(result.current).toMatchObject({ isConnected: false, error: "No token" });

		api.checkGitLabConnection.mockResolvedValueOnce({ success: false });
		await act(() => result.current.refresh());
		expect(result.current.error).toBe("Failed to check connection");

		api.checkGitLabConnection.mockRejectedValueOnce(new Error("ENOTFOUND"));
		await act(() => result.current.refresh());
		expect(result.current).toMatchObject({ error: "ENOTFOUND", isConnected: false });

		api.checkGitLabConnection.mockRejectedValueOnce("x");
		await act(() => result.current.refresh());
		expect(result.current.error).toBe("Failed to fetch MRs");
	});

	it("does nothing without a project", async () => {
		const { result } = await mounted(null);
		expect(api.checkGitLabConnection).not.toHaveBeenCalled();
		expect(result.current.getReviewStateForMR(1)).toBeNull();
		await act(() => result.current.runReview(1));
		expect(api.runGitLabMRReview).not.toHaveBeenCalled();
		expect(await result.current.checkNewCommits(1)).toEqual({ hasNewCommits: false });
	});
});

describe("the selected MR and its review", () => {
	it("selects an MR and reads its saved review", async () => {
		const { result } = await mounted();
		api.getGitLabMRReview.mockClear().mockResolvedValue(saved(1));
		act(() => result.current.selectMR(1));
		expect(result.current.selectedMR).toEqual(mr(1));
		await waitFor(() => expect(result.current.reviewResult).toEqual(saved(1)));
		act(() => result.current.selectMR(null));
		expect(result.current.selectedMR).toBeNull();
	});

	it("follows a review of the selected MR as it runs and ends", async () => {
		const { result } = await mounted();
		act(() => result.current.selectMR(1));
		await act(() => result.current.runReview(1));
		expect(api.runGitLabMRReview).toHaveBeenCalledWith("p1", 1);
		expect(result.current).toMatchObject({ isReviewing: true, activeMRReviews: [1] });

		const progress = { mrIid: 1, phase: "analyzing", progress: 50, message: "…" };
		act(() => reviews().setMRReviewProgress("p1", progress as never));
		expect(result.current.reviewProgress).toEqual(progress);

		act(() => reviews().setMRReviewResult("p1", saved(1) as never));
		expect(result.current).toMatchObject({ isReviewing: false, reviewResult: saved(1), activeMRReviews: [] });
	});

	it("runs a follow-up review", async () => {
		const { result } = await mounted();
		await act(() => result.current.runFollowupReview(2));
		expect(api.runGitLabMRFollowupReview).toHaveBeenCalledWith("p1", 2);
		expect(result.current.getReviewStateForMR(2)).toMatchObject({ isReviewing: true, error: null });
		expect(result.current.getReviewStateForMR(9)).toBeNull();
	});

	it("caches a new-commits check, and answers none when it fails", async () => {
		const { result } = await mounted();
		api.checkGitLabMRNewCommits.mockResolvedValueOnce({ hasNewCommits: true, newCommitCount: 2 });
		expect(await result.current.checkNewCommits(1)).toEqual({ hasNewCommits: true, newCommitCount: 2 });
		expect(reviews().getMRReviewState("p1", 1)?.newCommitsCheck).toEqual({ hasNewCommits: true, newCommitCount: 2 });

		api.checkGitLabMRNewCommits.mockRejectedValueOnce(new Error("rate limited"));
		let answer: unknown;
		await act(async () => {
			answer = await result.current.checkNewCommits(1);
		});
		expect(answer).toEqual({ hasNewCommits: false });
		expect(result.current.error).toBe("rate limited");
	});

	it("marks a cancelled review", async () => {
		const { result } = await mounted();
		reviews().startMRReview("p1", 1);
		api.cancelGitLabMRReview.mockResolvedValueOnce(true);
		expect(await result.current.cancelReview(1)).toBe(true);
		expect(reviews().getMRReviewState("p1", 1)).toMatchObject({ isReviewing: false, error: "Review cancelled by user" });

		api.cancelGitLabMRReview.mockResolvedValueOnce(false);
		expect(await result.current.cancelReview(2)).toBe(false);
		expect(reviews().getMRReviewState("p1", 2)).toBeNull();
	});
});

describe("MR actions", () => {
	type Hook = ReturnType<typeof useGitLabMRs>;
	const actions: Array<[string, (h: Hook) => Promise<boolean>, string, unknown[], string, boolean]> = [
		["cancelReview", (h) => h.cancelReview(1), "cancelGitLabMRReview", ["p1", 1], "Failed to cancel review", false],
		["postReview", (h) => h.postReview(1, ["f1"]), "postGitLabMRReview", ["p1", 1, ["f1"]], "Failed to post review", false],
		["postNote", (h) => h.postNote(1, "LGTM"), "postGitLabMRNote", ["p1", 1, "LGTM"], "Failed to post note", false],
		["mergeMR", (h) => h.mergeMR(1, "rebase"), "mergeGitLabMR", ["p1", 1, "rebase"], "Failed to merge MR", true],
		["assignMR", (h) => h.assignMR(1, [7]), "assignGitLabMR", ["p1", 1, [7]], "Failed to assign users", true],
		["approveMR", (h) => h.approveMR(1), "approveGitLabMR", ["p1", 1], "Failed to approve MR", false],
	];

	it.each(actions)("%s sends the request and passes its answer on", async (_n, run, method, args, _f, reloads) => {
		const { result } = await mounted();
		api.getGitLabMergeRequests.mockClear();
		api[method].mockResolvedValueOnce(true);
		let answer: unknown;
		await act(async () => {
			answer = await run(result.current);
		});
		expect(answer).toBe(true);
		expect(api[method]).toHaveBeenCalledWith(...args);
		expect(api.getGitLabMergeRequests).toHaveBeenCalledTimes(reloads ? 1 : 0);

		api[method].mockResolvedValueOnce(false);
		await act(async () => {
			answer = await run(result.current);
		});
		expect(answer).toBe(false);
		expect(api.getGitLabMergeRequests).toHaveBeenCalledTimes(reloads ? 1 : 0);
	});

	it.each(actions)("%s shows a failure and answers false", async (_n, run, method, _a, fallback) => {
		const { result } = await mounted();
		api[method].mockRejectedValueOnce(new Error("409 Conflict"));
		let answer: unknown;
		await act(async () => {
			answer = await run(result.current);
		});
		expect(answer).toBe(false);
		expect(result.current.error).toBe("409 Conflict");

		api[method].mockRejectedValueOnce("x");
		await act(async () => {
			answer = await run(result.current);
		});
		expect(result.current.error).toBe(fallback);
	});

	it.each(actions)("%s answers false when the bridge lacks it", async (_n, run, method) => {
		const { result } = await mounted();
		delete (api as Record<string, unknown>)[method];
		expect(await run(result.current)).toBe(false);
	});

	it("merges by squash unless told otherwise", async () => {
		const { result } = await mounted();
		api.mergeGitLabMR.mockResolvedValue(false);
		await result.current.mergeMR(1);
		expect(api.mergeGitLabMR).toHaveBeenCalledWith("p1", 1, "squash");
	});

	it("checks no new commits and reads no review when the bridge lacks them", async () => {
		delete (api as Record<string, unknown>).getGitLabMRReview;
		const { result } = await mounted();
		act(() => result.current.selectMR(1));
		delete (api as Record<string, unknown>).checkGitLabMRNewCommits;
		expect(await result.current.checkNewCommits(1)).toEqual({ hasNewCommits: false });
	});
});
