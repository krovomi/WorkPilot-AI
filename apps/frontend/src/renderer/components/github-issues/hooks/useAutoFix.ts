import { useCallback, useEffect, useRef, useState } from "react";
import type {
	AutoFixConfig,
	AutoFixQueueItem,
} from "../../../../preload/api/modules/github-api";

/**
 * Hook for the auto-fix of single issues: its settings, its queue, and the
 * polling for new issues while it is on.
 */
export function useAutoFix(projectId: string | undefined) {
	const [config, setConfig] = useState<AutoFixConfig | null>(null);
	const [queue, setQueue] = useState<AutoFixQueueItem[]>([]);
	// The project shown now: an answer for the previous one is dropped.
	const projectIdRef = useRef(projectId);
	projectIdRef.current = projectId;

	// Ref for auto-fix interval
	const autoFixIntervalRef = useRef<NodeJS.Timeout | null>(null);

	// Load the config and the queue on mount and when the project changes
	useEffect(() => {
		setConfig(null);
		setQueue([]);
		if (!projectId) return;

		Promise.all([
			window.electronAPI.github.getAutoFixConfig(projectId),
			window.electronAPI.github.getAutoFixQueue(projectId),
		])
			.then(([configResult, queueResult]) => {
				if (projectIdRef.current !== projectId) return;
				setConfig(configResult);
				setQueue(queueResult);
			})
			.catch((error) => {
				console.error("Failed to load auto-fix data:", error);
			});
	}, [projectId]);

	// Listen for completion events to refresh queue
	useEffect(() => {
		if (!projectId) return;

		const cleanupComplete = window.electronAPI.github.onAutoFixComplete(
			(eventProjectId: string) => {
				if (eventProjectId === projectId) {
					window.electronAPI.github
						.getAutoFixQueue(projectId)
						.then((next) => {
							if (projectIdRef.current === projectId) setQueue(next);
						})
						.catch((error) => {
							console.error("Failed to refresh the auto-fix queue:", error);
						});
				}
			},
		);

		return cleanupComplete;
	}, [projectId]);

	// Get queue item for a specific issue
	const getQueueItem = useCallback(
		(issueNumber: number): AutoFixQueueItem | null => {
			return queue.find((item) => item.issueNumber === issueNumber) || null;
		},
		[queue],
	);

	// Save config and optionally start/stop auto-fix
	const saveConfig = useCallback(
		async (newConfig: AutoFixConfig): Promise<boolean> => {
			if (!projectId) return false;

			try {
				const success = await window.electronAPI.github.saveAutoFixConfig(
					projectId,
					newConfig,
				);
				if (success) {
					setConfig(newConfig);
				}
				return success;
			} catch (error) {
				console.error("Failed to save auto-fix config:", error);
				return false;
			}
		},
		[projectId],
	);

	// Toggle auto-fix enabled (polling will handle new issues)
	const toggleAutoFix = useCallback(
		async (enabled: boolean) => {
			if (!config || !projectId) return false;

			const newConfig = { ...config, enabled };
			const success = await saveConfig(newConfig);

			// When enabled, the polling useEffect will automatically start checking
			// for new issues with auto-fix labels every 5 minutes

			return success;
		},
		[config, projectId, saveConfig],
	);

	// Auto-fix polling when enabled
	useEffect(() => {
		if (!projectId || !config?.enabled) {
			if (autoFixIntervalRef.current) {
				clearInterval(autoFixIntervalRef.current);
				autoFixIntervalRef.current = null;
			}
			return;
		}

		// Poll for new issues every 5 minutes when auto-fix is enabled
		const pollInterval = 5 * 60 * 1000; // 5 minutes

		autoFixIntervalRef.current = setInterval(async () => {
			try {
				// Check for new issues (no labels required)
				const newIssues =
					await window.electronAPI.github.checkNewIssues(projectId);
				if (newIssues.length > 0) {
					// Start individual auto-fix for each new issue (not batching)
					for (const issue of newIssues) {
						window.electronAPI.github.startAutoFix(projectId, issue.number);
					}
				}
			} catch (error) {
				console.error("[AutoFix] Error checking for new issues:", error);
			}
		}, pollInterval);

		return () => {
			if (autoFixIntervalRef.current) {
				clearInterval(autoFixIntervalRef.current);
				autoFixIntervalRef.current = null;
			}
		};
	}, [projectId, config?.enabled]);

	// Manually check for new issues (no labels required)
	const checkForNewIssues = useCallback(async () => {
		if (!projectId || !config?.enabled) return;

		try {
			const newIssues =
				await window.electronAPI.github.checkNewIssues(projectId);
			if (newIssues.length > 0) {
				// Start individual auto-fix for each new issue
				for (const issue of newIssues) {
					window.electronAPI.github.startAutoFix(projectId, issue.number);
				}
			}
		} catch (error) {
			console.error("[AutoFix] Error checking for new issues:", error);
		}
	}, [projectId, config?.enabled]);

	return {
		config,
		queue,
		getQueueItem,
		saveConfig,
		toggleAutoFix,
		checkForNewIssues,
	};
}
