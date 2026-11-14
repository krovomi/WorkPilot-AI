/**
 * Shared watch on a task's phase logs (`task_logs.json`, or a server card's
 * log feed).
 *
 * The main process keeps one watch per spec and `unwatchTaskLogs(specId)`
 * stops it outright. Two views read the same task's log: the task panel and
 * the Pixel Office bubble. When each watched and unwatched on its own, closing
 * the bubble silenced the task panel still open behind it. Counting holders
 * here keeps the watch alive until the last view lets go.
 */

const holders = new Map<string, number>();

/** Fire and forget: a watch that fails leaves the view on what it loaded. */
function quietly(call: () => Promise<unknown> | undefined): void {
	try {
		call()?.catch(() => undefined);
	} catch {
		// The bridge is missing (tests, a closing window): nothing to watch.
	}
}

/** Watch `specId`'s log for as long as the returned release is not called. */
export function retainTaskLogWatch(
	projectId: string,
	specId: string,
): () => void {
	const count = holders.get(specId) ?? 0;
	holders.set(specId, count + 1);
	if (count === 0) {
		quietly(() => window.electronAPI.watchTaskLogs(projectId, specId));
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const left = (holders.get(specId) ?? 1) - 1;
		if (left > 0) {
			holders.set(specId, left);
			return;
		}
		holders.delete(specId);
		quietly(() => window.electronAPI.unwatchTaskLogs(specId));
	};
}

/** Test seam: forget every holder. */
export function resetTaskLogWatchesForTests(): void {
	holders.clear();
}
