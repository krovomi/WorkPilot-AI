import { useCallback, useEffect, useMemo, useState } from "react";
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
	} = useIssuesStore();

	const syncStatus = useSyncStatusStore((s) => s.syncStatus);
	const connectionError = useSyncStatusStore((s) => s.connectionError);

	// A search reads every issue, not one page: it has to see them all.
	const [isSearchActive, setIsSearchActive] = useState(false);

	// Always check connection when component mounts or projectId changes
	// (in case settings changed).
	useEffect(() => {
		if (projectId) checkGitHubConnection(projectId);
	}, [projectId]);

	// The one place issues are loaded: on connection, and whenever the filter
	// or the search mode changes. The search handlers only flip the mode, so a
	// search loads once, not twice.
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

	// Searching loads every issue; clearing goes back to pages.
	const handleSearchStart = useCallback(() => setIsSearchActive(true), []);
	const handleSearchClear = useCallback(() => setIsSearchActive(false), []);

	// Compute selectedIssue from issues array
	const selectedIssue = useMemo(() => {
		return issues.find((i) => i.number === selectedIssueNumber) || null;
	}, [issues, selectedIssueNumber]);

	return {
		issues,
		syncStatus,
		connectionError,
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
