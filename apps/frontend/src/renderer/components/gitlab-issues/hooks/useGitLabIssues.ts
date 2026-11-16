import { useCallback, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
	checkGitLabConnection,
	loadGitLabIssues,
	useGitLabStore,
} from "../../../stores/gitlab-store";
import type { FilterState } from "../types";

export function useGitLabIssues(projectId: string | undefined) {
	const {
		issues,
		syncStatus,
		isLoading,
		error,
		selectedIssueIid,
		filterState,
		selectIssue,
		setFilterState,
		getFilteredIssues,
		getOpenIssuesCount,
	} = useGitLabStore(
		useShallow((state) => ({
			issues: state.issues,
			syncStatus: state.syncStatus,
			isLoading: state.isLoading,
			error: state.error,
			selectedIssueIid: state.selectedIssueIid,
			filterState: state.filterState,
			selectIssue: state.selectIssue,
			setFilterState: state.setFilterState,
			getFilteredIssues: state.getFilteredIssues,
			getOpenIssuesCount: state.getOpenIssuesCount,
		})),
	);

	// Always check connection when component mounts or projectId changes
	useEffect(() => {
		if (projectId) {
			// Always check connection on mount (in case settings changed)
			checkGitLabConnection(projectId);
		}
	}, [projectId]);

	// Load issues when filter changes or after connection is established
	useEffect(() => {
		if (projectId && syncStatus?.connected) {
			loadGitLabIssues(projectId, filterState);
		}
	}, [projectId, filterState, syncStatus?.connected]);

	const handleRefresh = useCallback(() => {
		if (projectId) {
			// Re-check connection and reload issues
			checkGitLabConnection(projectId);
			loadGitLabIssues(projectId, filterState);
		}
	}, [projectId, filterState]);

	// The loading effect above reloads on the new filter: loading here too
	// sent every request twice.
	const handleFilterChange = useCallback(
		(state: FilterState) => setFilterState(state),
		[setFilterState],
	);

	// Compute selectedIssue from issues array
	const selectedIssue = useMemo(() => {
		return issues.find((i) => i.iid === selectedIssueIid) || null;
	}, [issues, selectedIssueIid]);

	return {
		issues,
		syncStatus,
		isLoading,
		error,
		selectedIssueIid,
		selectedIssue,
		filterState,
		selectIssue,
		getFilteredIssues,
		getOpenIssuesCount,
		handleRefresh,
		handleFilterChange,
	};
}
