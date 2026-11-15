/**
 * The GitLab MR review store: one review state per project and MR, kept
 * across navigation, fed by the main process's review events, and what
 * starting a review asks for.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	GitLabMRReviewProgress,
	GitLabMRReviewResult,
	GitLabNewCommitsCheck,
} from "../../../shared/types";
import {
	setupMRReviewListeners,
	startFollowupReview,
	startMRReview,
	useMRReviewStore,
} from "../gitlab";

type Listener = (projectId: string, payload: never) => void;
const listeners: Record<string, Listener> = {};
const unsubscribe = { progress: vi.fn(), complete: vi.fn(), error: vi.fn() };
const api = {
	onGitLabMRReviewProgress: vi.fn((cb: Listener) => {
		listeners.progress = cb;
		return unsubscribe.progress;
	}),
	onGitLabMRReviewComplete: vi.fn((cb: Listener) => {
		listeners.complete = cb;
		return unsubscribe.complete;
	}),
	onGitLabMRReviewError: vi.fn((cb: Listener) => {
		listeners.error = cb;
		return unsubscribe.error;
	}),
	runGitLabMRReview: vi.fn(),
	runGitLabMRFollowupReview: vi.fn(),
};

const progress = (mrIid: number) =>
	({ mrIid, phase: "analyzing", progress: 40, message: "…" }) as unknown as GitLabMRReviewProgress;
const result = (mrIid: number) =>
	({ mrIid, findings: [], summary: "ok" }) as unknown as GitLabMRReviewResult;
const check = { hasNewCommits: true } as unknown as GitLabNewCommitsCheck;

const INITIAL = useMRReviewStore.getState();
const store = () => useMRReviewStore.getState();

beforeEach(() => {
	useMRReviewStore.setState(INITIAL, true);
	for (const fn of [...Object.values(api), ...Object.values(unsubscribe)]) fn.mockClear();
	(window as unknown as { electronAPI: typeof api }).electronAPI = api;
});

describe("review state per project and MR", () => {
	it("starts a review, keeping the last new-commits check", () => {
		store().setNewCommitsCheck("p1", 7, check);
		store().startMRReview("p1", 7);
		expect(store().getMRReviewState("p1", 7)).toEqual({
			mrIid: 7,
			projectId: "p1",
			isReviewing: true,
			progress: null,
			result: null,
			error: null,
			newCommitsCheck: check,
		});
		expect(store().getMRReviewState("p2", 7)).toBeNull();
	});

	it("records progress, keeping an earlier result", () => {
		store().setMRReviewResult("p1", result(7));
		store().setMRReviewProgress("p1", progress(7));
		expect(store().getMRReviewState("p1", 7)).toMatchObject({
			isReviewing: true,
			progress: progress(7),
			result: result(7),
		});
		store().setMRReviewProgress("p1", progress(8));
		expect(store().getMRReviewState("p1", 8)).toMatchObject({ result: null, newCommitsCheck: null });
	});

	it("a finished review clears its progress and the new-commits check", () => {
		store().setNewCommitsCheck("p1", 7, check);
		store().setMRReviewProgress("p1", progress(7));
		store().setMRReviewResult("p1", result(7));
		expect(store().getMRReviewState("p1", 7)).toMatchObject({
			isReviewing: false,
			progress: null,
			result: result(7),
			newCommitsCheck: null,
		});
	});

	it("an error stops the review and keeps the last result", () => {
		store().setMRReviewResult("p1", result(7));
		store().startMRReview("p1", 7);
		store().setMRReviewError("p1", 7, "quota");
		expect(store().getMRReviewState("p1", 7)).toMatchObject({
			isReviewing: false,
			result: null,
			error: "quota",
		});
		store().setMRReviewResult("p1", result(7));
		store().setNewCommitsCheck("p1", 7, check);
		store().setMRReviewError("p1", 7, "again");
		expect(store().getMRReviewState("p1", 7)).toMatchObject({
			result: result(7),
			newCommitsCheck: check,
			error: "again",
		});
		store().setMRReviewError("p1", 9, "first");
		expect(store().getMRReviewState("p1", 9)).toMatchObject({ result: null, newCommitsCheck: null });
	});

	it("stores a new-commits check on an MR never reviewed, or on an existing review", () => {
		store().setNewCommitsCheck("p1", 3, check);
		expect(store().getMRReviewState("p1", 3)).toMatchObject({ isReviewing: false, newCommitsCheck: check });
		store().setMRReviewResult("p1", result(4));
		store().setNewCommitsCheck("p1", 4, check);
		expect(store().getMRReviewState("p1", 4)).toMatchObject({ result: result(4), newCommitsCheck: check });
	});

	it("lists the reviews running in a project, and forgets a cleared one", () => {
		store().startMRReview("p1", 1);
		store().startMRReview("p1", 2);
		store().startMRReview("p2", 3);
		store().setMRReviewResult("p1", result(2));
		expect(store().getActiveMRReviews("p1").map((r) => r.mrIid)).toEqual([1]);
		store().clearMRReview("p1", 1);
		expect(store().getMRReviewState("p1", 1)).toBeNull();
		expect(store().getActiveMRReviews("p1")).toEqual([]);
	});
});

describe("starting a review", () => {
	it("tracks the review and asks the main process to run it", () => {
		startMRReview("p1", 7);
		expect(api.runGitLabMRReview).toHaveBeenCalledWith("p1", 7);
		expect(store().getMRReviewState("p1", 7)?.isReviewing).toBe(true);
	});

	it("runs a follow-up review the same way", () => {
		startFollowupReview("p1", 7);
		expect(api.runGitLabMRFollowupReview).toHaveBeenCalledWith("p1", 7);
		expect(store().getMRReviewState("p1", 7)?.isReviewing).toBe(true);
	});
});

describe("setupMRReviewListeners", () => {
	it("feeds progress, results and errors into the store, and unregisters all three", () => {
		const teardown = setupMRReviewListeners();
		listeners.progress("p1", progress(7) as never);
		expect(store().getMRReviewState("p1", 7)?.progress).toEqual(progress(7));
		listeners.complete("p1", result(7) as never);
		expect(store().getMRReviewState("p1", 7)?.result).toEqual(result(7));
		listeners.error("p1", { mrIid: 8, error: "boom" } as never);
		expect(store().getMRReviewState("p1", 8)?.error).toBe("boom");

		teardown();
		expect(unsubscribe.progress).toHaveBeenCalledOnce();
		expect(unsubscribe.complete).toHaveBeenCalledOnce();
		expect(unsubscribe.error).toHaveBeenCalledOnce();
	});
});
