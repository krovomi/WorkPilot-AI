import { useCallback, useEffect, useState } from "react";
import type { MemoryLifecycleView } from "../../../../shared/types";

/**
 * The project's memory lifecycle (journal, trash, conflicts), read on demand.
 *
 * Invokes only — no IPC listener lives here (`stores/global-listeners.ts`
 * owns those): the tab reads when it opens and after each decision.
 */
export function useMemoryLifecycle(projectId: string) {
	const [view, setView] = useState<MemoryLifecycleView | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		if (!projectId) return;
		setLoading(true);
		try {
			const result = await window.electronAPI.getMemoryLifecycle(projectId);
			if (result.success && result.data) {
				setView(result.data);
				setError(null);
			} else {
				setError(result.error ?? "failed");
			}
		} catch {
			setError("failed");
		} finally {
			setLoading(false);
		}
	}, [projectId]);

	useEffect(() => {
		void reload();
	}, [reload]);

	return { view, loading, error, reload };
}
