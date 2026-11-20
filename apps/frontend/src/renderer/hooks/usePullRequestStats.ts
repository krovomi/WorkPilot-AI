import { useEffect, useState } from "react";
import type { PRData } from "../../shared/types";

interface UsePullRequestStatsResult {
	prData: PRData | null;
	isLoading: boolean;
	error: string | null;
}

/**
 * Hook to fetch PR stats from a PR URL
 * Retrieves file count, additions, deletions, and other PR metadata
 */
export function usePullRequestStats(
	prUrl: string | null | undefined,
	taskId?: string,
): UsePullRequestStatsResult {
	const [prData, setPRData] = useState<PRData | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!prUrl || !taskId) {
			setPRData(null);
			setError(null);
			setIsLoading(false);
			return;
		}
		// Another PR or task while this one was out: its answer is not theirs.
		let stale = false;

		const fetchPRData = async () => {
			// The last PR's stats are not this one's, even while it loads.
			setPRData(null);
			setIsLoading(true);
			setError(null);

			try {
				// Extract PR number from Azure DevOps URL or GitHub URL
				let prNumber: number | null = null;

				// Azure DevOps PR URL format: /pullrequest/123456
				const azureMatch = /pullrequest\/(\d+)/.exec(prUrl);
				if (azureMatch) {
					prNumber = Number.parseInt(azureMatch[1], 10);
				} else {
					// GitHub PR URL format: /pull/123
					const githubMatch = /\/pull\/(\d+)/.exec(prUrl);
					if (githubMatch) {
						prNumber = Number.parseInt(githubMatch[1], 10);
					}
				}

				if (!prNumber) {
					setError("Could not extract PR number from URL");
					return;
				}

				// Call the universal PR details handler
				const result = await globalThis.electronAPI.getPRDetails(
					prNumber,
					taskId,
				);
				if (stale) return;

				if (result.success && result.data?.data) {
					setPRData(result.data.data);
				} else {
					setError(result.data?.error || result.error || "Failed to fetch PR details");
				}
			} catch (err) {
				if (stale) return;
				console.error("Error fetching PR stats:", err);
				setError(
					err instanceof Error ? err.message : "Unknown error occurred",
				);
			} finally {
				if (!stale) setIsLoading(false);
			}
		};

		void fetchPRData();
		return () => {
			stale = true;
		};
	}, [prUrl, taskId]);

	return { prData, isLoading, error };
}
