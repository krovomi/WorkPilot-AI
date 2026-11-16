/**
 * Hook for loading Linear projects for a selected team
 */

import { useEffect, useState } from "react";
import type { LinearProject } from "../types";

export function useLinearProjects(projectId: string, selectedTeamId: string) {
	const [projects, setProjects] = useState<LinearProject[]>([]);
	const [isLoadingProjects, setIsLoadingProjects] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		// A slower answer for an earlier choice must not replace this one.
		let stale = false;
		const loadProjects = async () => {
			if (!selectedTeamId) {
				setProjects([]);
				setIsLoadingProjects(false);
				return;
			}

			setIsLoadingProjects(true);
			setError(null);

			try {
				const result = await window.electronAPI.getLinearProjects(
					projectId,
					selectedTeamId,
				);
				if (stale) return;
				if (result.success && result.data) {
					setProjects(result.data);
				} else {
					setError(result.error || "Failed to load projects");
				}
			} catch (err) {
				if (!stale) setError(err instanceof Error ? err.message : "Unknown error");
			} finally {
				if (!stale) setIsLoadingProjects(false);
			}
		};

		loadProjects();
		return () => {
			stale = true;
		};
	}, [projectId, selectedTeamId]);

	return { projects, isLoadingProjects, error, setError };
}
