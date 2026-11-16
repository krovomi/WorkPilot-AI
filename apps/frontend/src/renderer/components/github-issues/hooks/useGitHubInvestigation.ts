import { useCallback } from "react";
import type { GitHubIssue } from "../../../../shared/types";
import {
	investigateGitHubIssue,
	useInvestigationStore,
} from "../../../stores/github";

/**
 * The investigation shown on the issues page. Its events are followed by
 * setupGitHubInvestigationListeners for the life of the window, not here.
 */
export function useGitHubInvestigation(projectId: string | undefined) {
	const investigationStatus = useInvestigationStore(
		(state) => state.investigationStatus,
	);
	const lastInvestigationResult = useInvestigationStore(
		(state) => state.lastInvestigationResult,
	);
	const setInvestigationStatus = useInvestigationStore(
		(state) => state.setInvestigationStatus,
	);

	const startInvestigation = useCallback(
		(issue: GitHubIssue, selectedCommentIds: number[]) => {
			if (projectId) {
				investigateGitHubIssue(projectId, issue.number, selectedCommentIds);
			}
		},
		[projectId],
	);

	const resetInvestigationStatus = useCallback(() => {
		setInvestigationStatus({ phase: "idle", progress: 0, message: "" });
	}, [setInvestigationStatus]);

	return {
		investigationStatus,
		lastInvestigationResult,
		startInvestigation,
		resetInvestigationStatus,
	};
}
