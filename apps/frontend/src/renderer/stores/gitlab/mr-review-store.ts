import { create } from "zustand";
import type {
	GitLabMRReviewProgress,
	GitLabMRReviewResult,
	GitLabNewCommitsCheck,
} from "../../../shared/types";

/**
 * MR review state for a single MR
 */
interface MRReviewState {
	mrIid: number;
	projectId: string;
	isReviewing: boolean;
	progress: GitLabMRReviewProgress | null;
	result: GitLabMRReviewResult | null;
	error: string | null;
	/** Cached result of new commits check - updated when detail view checks */
	newCommitsCheck: GitLabNewCommitsCheck | null;
}

interface MRReviewStoreState {
	// MR Review state - persists across navigation
	// Key: `${projectId}:${mrIid}`
	mrReviews: Record<string, MRReviewState>;

	// Actions
	startMRReview: (projectId: string, mrIid: number) => void;
	setMRReviewProgress: (
		projectId: string,
		progress: GitLabMRReviewProgress,
	) => void;
	setMRReviewResult: (projectId: string, result: GitLabMRReviewResult) => void;
	setMRReviewError: (projectId: string, mrIid: number, error: string) => void;
	setNewCommitsCheck: (
		projectId: string,
		mrIid: number,
		check: GitLabNewCommitsCheck,
	) => void;
	clearMRReview: (projectId: string, mrIid: number) => void;

	// Selectors
	getMRReviewState: (projectId: string, mrIid: number) => MRReviewState | null;
	getActiveMRReviews: (projectId: string) => MRReviewState[];
}

export const useMRReviewStore = create<MRReviewStoreState>((set, get) => ({
	// Initial state
	mrReviews: {},

	// Actions
	startMRReview: (projectId: string, mrIid: number) =>
		set((state) => {
			const key = `${projectId}:${mrIid}`;
			const existing = state.mrReviews[key];
			return {
				mrReviews: {
					...state.mrReviews,
					[key]: {
						mrIid,
						projectId,
						isReviewing: true,
						progress: null,
						result: null,
						error: null,
						newCommitsCheck: existing?.newCommitsCheck ?? null,
					},
				},
			};
		}),

	setMRReviewProgress: (projectId: string, progress: GitLabMRReviewProgress) =>
		set((state) => {
			const key = `${projectId}:${progress.mrIid}`;
			const existing = state.mrReviews[key];
			return {
				mrReviews: {
					...state.mrReviews,
					[key]: {
						mrIid: progress.mrIid,
						projectId,
						isReviewing: true,
						progress,
						result: existing?.result ?? null,
						error: null,
						newCommitsCheck: existing?.newCommitsCheck ?? null,
					},
				},
			};
		}),

	setMRReviewResult: (projectId: string, result: GitLabMRReviewResult) =>
		set((state) => {
			const key = `${projectId}:${result.mrIid}`;
			return {
				mrReviews: {
					...state.mrReviews,
					[key]: {
						mrIid: result.mrIid,
						projectId,
						isReviewing: false,
						progress: null,
						result,
						error: null,
						// Clear new commits check when review completes (it was just reviewed)
						newCommitsCheck: null,
					},
				},
			};
		}),

	setMRReviewError: (projectId: string, mrIid: number, error: string) =>
		set((state) => {
			const key = `${projectId}:${mrIid}`;
			const existing = state.mrReviews[key];
			return {
				mrReviews: {
					...state.mrReviews,
					[key]: {
						mrIid,
						projectId,
						isReviewing: false,
						progress: null,
						result: existing?.result ?? null,
						error,
						newCommitsCheck: existing?.newCommitsCheck ?? null,
					},
				},
			};
		}),

	setNewCommitsCheck: (
		projectId: string,
		mrIid: number,
		check: GitLabNewCommitsCheck,
	) =>
		set((state) => {
			const key = `${projectId}:${mrIid}`;
			const existing = state.mrReviews[key];
			if (!existing) {
				// Create a minimal state if none exists
				return {
					mrReviews: {
						...state.mrReviews,
						[key]: {
							mrIid,
							projectId,
							isReviewing: false,
							progress: null,
							result: null,
							error: null,
							newCommitsCheck: check,
						},
					},
				};
			}
			return {
				mrReviews: {
					...state.mrReviews,
					[key]: {
						...existing,
						newCommitsCheck: check,
					},
				},
			};
		}),

	clearMRReview: (projectId: string, mrIid: number) =>
		set((state) => {
			const key = `${projectId}:${mrIid}`;
			const { [key]: _, ...rest } = state.mrReviews;
			return { mrReviews: rest };
		}),

	// Selectors
	getMRReviewState: (projectId: string, mrIid: number) => {
		const { mrReviews } = get();
		const key = `${projectId}:${mrIid}`;
		return mrReviews[key] ?? null;
	},

	getActiveMRReviews: (projectId: string) => {
		const { mrReviews } = get();
		return Object.values(mrReviews).filter(
			(review) => review.projectId === projectId && review.isReviewing,
		);
	},
}));

/**
 * MR review events, registered once for the window by `global-listeners.ts`
 * so a review that finishes while the GitLab page is closed still lands in
 * the store. Returns the teardown.
 */
export function setupMRReviewListeners(): () => void {
	const store = useMRReviewStore.getState();
	const cleanups = [
		window.electronAPI.onGitLabMRReviewProgress((projectId, progress) =>
			store.setMRReviewProgress(projectId, progress),
		),
		window.electronAPI.onGitLabMRReviewComplete((projectId, result) =>
			store.setMRReviewResult(projectId, result),
		),
		window.electronAPI.onGitLabMRReviewError((projectId, data) =>
			store.setMRReviewError(projectId, data.mrIid, data.error),
		),
	];
	return () => {
		for (const cleanup of cleanups) cleanup();
	};
}

/**
 * Start an MR review and track it in the store
 */
export function startMRReview(projectId: string, mrIid: number): void {
	const store = useMRReviewStore.getState();
	store.startMRReview(projectId, mrIid);
	window.electronAPI.runGitLabMRReview(projectId, mrIid);
}

/**
 * Start a follow-up MR review and track it in the store
 */
export function startFollowupReview(projectId: string, mrIid: number): void {
	const store = useMRReviewStore.getState();
	store.startMRReview(projectId, mrIid);
	window.electronAPI.runGitLabMRFollowupReview(projectId, mrIid);
}
