/**
 * Hook for filtering and searching GitHub PRs
 */

import { useCallback, useMemo, useState } from "react";
import type { PRData } from "../../../../preload/api/modules/github-api";
import { getPRReviewStatus, type PRReviewInfo } from "../utils/pr-review-status";

export type PRStatusFilter =
	| "reviewing"
	| "not_reviewed"
	| "reviewed"
	| "posted"
	| "changes_requested"
	| "ready_to_merge"
	| "ready_for_followup";

export type PRSortOption = "newest" | "oldest" | "largest";

export interface PRFilterState {
	searchQuery: string;
	contributors: string[];
	statuses: PRStatusFilter[];
	sortBy: PRSortOption;
}

const POSTED: ReadonlySet<PRStatusFilter> = new Set([
	"ready_to_merge",
	"changes_requested",
	"ready_for_followup",
]);

const DEFAULT_FILTERS: PRFilterState = {
	searchQuery: "",
	contributors: [],
	statuses: [],
	sortBy: "newest",
};

export function usePRFiltering(
	prs: PRData[],
	getReviewStateForPR: (prNumber: number) => PRReviewInfo | null,
) {
	const [filters, setFiltersState] = useState<PRFilterState>(DEFAULT_FILTERS);

	// Derive unique contributors from PRs
	const contributors = useMemo(() => {
		const authorSet = new Set<string>();
		prs.forEach((pr) => {
			if (pr.author?.login) {
				authorSet.add(pr.author.login);
			}
		});
		return Array.from(authorSet).sort((a, b) =>
			a.toLowerCase().localeCompare(b.toLowerCase()),
		);
	}, [prs]);

	// Filter and sort PRs based on current filters
	const filteredPRs = useMemo(() => {
		const filtered = prs.filter((pr) => {
			// Search filter - matches title or body
			if (filters.searchQuery) {
				const query = filters.searchQuery.toLowerCase();
				const matchesTitle = pr.title.toLowerCase().includes(query);
				const matchesBody = pr.body?.toLowerCase().includes(query);
				const matchesNumber = pr.number.toString().includes(query);
				if (!matchesTitle && !matchesBody && !matchesNumber) {
					return false;
				}
			}

			// Contributors filter (multi-select)
			if (filters.contributors.length > 0) {
				const authorLogin = pr.author?.login;
				if (!authorLogin || !filters.contributors.includes(authorLogin)) {
					return false;
				}
			}

			// Status filter (multi-select)
			if (filters.statuses.length > 0) {
				const status = getPRReviewStatus(getReviewStateForPR(pr.number));
				// "Posted" takes every state a posted review can be in.
				const matchesStatus = filters.statuses.some((wanted) =>
					wanted === "posted" ? POSTED.has(status) : status === wanted,
				);

				if (!matchesStatus) {
					return false;
				}
			}

			return true;
		});

		// Read each date once, not on every comparison.
		const dated = filtered.map((pr) => ({
			pr,
			time: new Date(pr.createdAt).getTime(),
			changes: (pr.additions || 0) + (pr.deletions || 0),
		}));
		const compare = (a: (typeof dated)[number], b: (typeof dated)[number]) => {
			switch (filters.sortBy) {
				case "newest":
					return b.time - a.time;
				case "oldest":
					return a.time - b.time;
				case "largest":
					// Then the newest first, for a stable order.
					return b.changes - a.changes || b.time - a.time;
			}
		};
		return dated.sort(compare).map(({ pr }) => pr);
	}, [prs, filters, getReviewStateForPR]);

	// Filter setters
	const setSearchQuery = useCallback((query: string) => {
		setFiltersState((prev) => ({ ...prev, searchQuery: query }));
	}, []);

	const setContributors = useCallback((contributors: string[]) => {
		setFiltersState((prev) => ({ ...prev, contributors }));
	}, []);

	const setStatuses = useCallback((statuses: PRStatusFilter[]) => {
		setFiltersState((prev) => ({ ...prev, statuses }));
	}, []);

	const setSortBy = useCallback((sortBy: PRSortOption) => {
		setFiltersState((prev) => ({ ...prev, sortBy }));
	}, []);

	const clearFilters = useCallback(() => {
		setFiltersState((prev) => ({
			...DEFAULT_FILTERS,
			sortBy: prev.sortBy, // Preserve sort preference when clearing filters
		}));
	}, []);

	const hasActiveFilters = useMemo(() => {
		return (
			filters.searchQuery !== "" ||
			filters.contributors.length > 0 ||
			filters.statuses.length > 0
		);
	}, [filters]);

	return {
		filteredPRs,
		contributors,
		filters,
		setSearchQuery,
		setContributors,
		setStatuses,
		setSortBy,
		clearFilters,
		hasActiveFilters,
	};
}
