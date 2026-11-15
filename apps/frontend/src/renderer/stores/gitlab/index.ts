/**
 * GitLab Stores - Focused state management for GitLab integration
 *
 * This module exports all GitLab-related stores and their utilities.
 */

// MR Review Store
export {
	setupMRReviewListeners,
	startFollowupReview,
	startMRReview,
	useMRReviewStore,
} from "./mr-review-store";

// Re-export types for convenience
export type {
	GitLabInvestigationResult,
	GitLabInvestigationStatus,
	GitLabMergeRequest,
	GitLabMRReviewProgress,
	GitLabMRReviewResult,
	GitLabNewCommitsCheck,
	GitLabSyncStatus,
} from "../../../shared/types";
