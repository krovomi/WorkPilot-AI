import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
	checkGitHubConnection,
	loadGitHubIssues,
	loadMoreGitHubIssues,
	useIssuesStore,
	useSyncStatusStore,
} from "../../../stores/github";
import type { FilterState } from "../types";

export function useGitHubIssues(projectId: string | undefined) {
	const {
		issues,
		isLoading,
		isLoadingMore,
		error,
		selectedIssueNumber,
		filterState,
		hasMore,
		selectIssue,
		setFilterState,
		getFilteredIssues,
		getOpenIssuesCount,
	} = useIssuesStore(
		useShallow((state) => ({
			issues: state.issues,
			isLoading: state.isLoading,
			isLoadingMore: state.isLoadingMore,
			error: state.error,
			selectedIssueNumber: state.selectedIssueNumber,
			filterState: state.filterState,
			hasMore: state.hasMore,
			selectIssue: state.selectIssue,
			setFilterState: state.setFilterState,
			getFilteredIssues: state.getFilteredIssues,
			getOpenIssuesCount: state.getOpenIssuesCount,
		})),
	);

	const syncStatus = useSyncStatusStore((state) => state.syncStatus);

	// Track if search is active (need to load all issues for search)
	const [isSearchActive, setIsSearchActive] = useState(false);

	// Check the connection (settings may have changed) and leave search mode
	// whenever the project changes.
	useEffect(() => {
		setIsSearchActive(false);
		if (projectId) {
			checkGitHubConnection(projectId);
		}
	}, [projectId]);

	// The one place issues load: on connection, and whenever the filter or the
	// search mode changes (a search needs every issue, not one page).
	useEffect(() => {
		if (projectId && syncStatus?.connected) {
			loadGitHubIssues(projectId, filterState, isSearchActive);
		}
	}, [projectId, filterState, syncStatus?.connected, isSearchActive]);

	const handleRefresh = useCallback(() => {
		if (projectId) {
			// Re-check connection and reload issues
			checkGitHubConnection(projectId);
			loadGitHubIssues(projectId, filterState, isSearchActive);
		}
	}, [projectId, filterState, isSearchActive]);

	const handleFilterChange = useCallback(
		(state: FilterState) => {
			// Only update filter state - useEffect handles loading when filterState changes
			// This prevents duplicate API calls
			setFilterState(state);
		},
		[setFilterState],
	);

	const handleLoadMore = useCallback(() => {
		if (projectId && !isSearchActive) {
			loadMoreGitHubIssues(projectId, filterState);
		}
	}, [projectId, filterState, isSearchActive]);

	// Searching loads every issue, clearing the search goes back to pages:
	// the loading effect above does both when the mode changes.
	const handleSearchStart = useCallback(() => setIsSearchActive(true), []);
	const handleSearchClear = useCallback(() => setIsSearchActive(false), []);

	// Compute selectedIssue from issues array
	const selectedIssue = useMemo(() => {
		return issues.find((i) => i.number === selectedIssueNumber) || null;
	}, [issues, selectedIssueNumber]);

	return {
		issues,
		syncStatus,
		isLoading,
		isLoadingMore,
		error,
		selectedIssueNumber,
		selectedIssue,
		filterState,
		hasMore: !isSearchActive && hasMore, // No "load more" when search is active
		selectIssue,
		getFilteredIssues,
		getOpenIssuesCount,
		handleRefresh,
		handleFilterChange,
		handleLoadMore,
		handleSearchStart,
		handleSearchClear,
	};
}
