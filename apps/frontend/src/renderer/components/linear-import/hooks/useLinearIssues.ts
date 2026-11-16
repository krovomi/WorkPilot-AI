/**
 * Hook for loading Linear issues for a selected team/project
 */

import { useEffect, useRef, useState } from "react";
import type { LinearIssue } from "../types";

export function useLinearIssues(
	projectId: string,
	selectedTeamId: string,
	selectedProjectId: string,
	onIssuesChange?: () => void,
) {
	const [issues, setIssues] = useState<LinearIssue[]>([]);
	const [isLoadingIssues, setIsLoadingIssues] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Use ref to store the callback to avoid unnecessary re-renders
	const onIssuesChangeRef = useRef(onIssuesChange);
	onIssuesChangeRef.current = onIssuesChange;

	useEffect(() => {
		// A slower answer for an earlier choice must not replace this one.
		let stale = false;
		const loadIssues = async () => {
			if (!selectedTeamId) {
				setIssues([]);
				setIsLoadingIssues(false);
				return;
			}

			setIsLoadingIssues(true);
			setError(null);

			try {
				const result = await window.electronAPI.getLinearIssues(
					projectId,
					selectedTeamId,
					selectedProjectId || undefined,
				);
				if (stale) return;
				if (result.success && result.data) {
					setIssues(result.data);
					onIssuesChangeRef.current?.();
				} else {
					setError(result.error || "Failed to load issues");
				}
			} catch (err) {
				if (!stale) setError(err instanceof Error ? err.message : "Unknown error");
			} finally {
				if (!stale) setIsLoadingIssues(false);
			}
		};

		loadIssues();
		return () => {
			stale = true;
		};
	}, [projectId, selectedTeamId, selectedProjectId]);

	return { issues, isLoadingIssues, error, setError };
}
