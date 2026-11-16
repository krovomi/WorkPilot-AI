/**
 * Hook for loading Linear teams
 */

import { useEffect, useState } from "react";
import type { LinearTeam } from "../types";

export function useLinearTeams(projectId: string, open: boolean) {
	const [teams, setTeams] = useState<LinearTeam[]>([]);
	const [isLoadingTeams, setIsLoadingTeams] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		// A slower answer for an earlier choice must not replace this one.
		let stale = false;
		const loadTeams = async () => {
			if (!open) {
				setIsLoadingTeams(false);
				return;
			}

			setIsLoadingTeams(true);
			setError(null);

			try {
				const result = await window.electronAPI.getLinearTeams(projectId);
				if (stale) return;
				if (result.success && result.data) {
					setTeams(result.data);
				} else {
					setError(result.error || "Failed to load teams");
				}
			} catch (err) {
				if (!stale) setError(err instanceof Error ? err.message : "Unknown error");
			} finally {
				if (!stale) setIsLoadingTeams(false);
			}
		};

		loadTeams();
		return () => {
			stale = true;
		};
	}, [open, projectId]);

	return { teams, isLoadingTeams, error, setError };
}
