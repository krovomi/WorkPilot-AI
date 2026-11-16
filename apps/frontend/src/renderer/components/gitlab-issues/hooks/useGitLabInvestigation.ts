import { useCallback } from "react";
import type { GitLabIssue } from "../../../../shared/types";
import {
	investigateGitLabIssue,
	useGitLabStore,
} from "../../../stores/gitlab-store";

/**
 * The investigation shown on the issues page. Its events are followed by
 * setupGitLabInvestigationListeners for the life of the window, not here.
 */
export function useGitLabInvestigation(projectId: string | undefined) {
	const investigationStatus = useGitLabStore(
		(state) => state.investigationStatus,
	);
	const lastInvestigationResult = useGitLabStore(
		(state) => state.lastInvestigationResult,
	);
	const setInvestigationStatus = useGitLabStore(
		(state) => state.setInvestigationStatus,
	);

	const startInvestigation = useCallback(
		(issue: GitLabIssue, selectedNoteIds: number[]) => {
			if (projectId) {
				investigateGitLabIssue(projectId, issue.iid, selectedNoteIds);
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
