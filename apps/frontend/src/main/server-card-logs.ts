/**
 * The build log of a server card (server mode), for the task's Logs tab.
 *
 * A run on the server writes its journal in the server's clone; the app's
 * mirror never holds it. The server merges the spec folder's copy and the
 * build workspace's, as `task-log-service.ts` does for a local card, and sends
 * a bounded, masked copy (`GET /api/board/cards/{id}/logs`,
 * `apps/backend/shared_board/logs.py`).
 *
 * Watching a card reads it again every few seconds while the Logs tab is
 * open, and sends the logs to the window only when they changed. A failed
 * read keeps what the tab shows.
 */

import type { IPCResult, Project, TaskLogs } from "../shared/types";
import { authedFetch } from "./server-connection";

/** How often a watched card's log is read again. */
export const SERVER_LOGS_POLL_MS = 3_000;

function logsUrl(project: Project, cardId: string): string {
	return `/api/board/cards/${encodeURIComponent(cardId)}/logs?project_id=${encodeURIComponent(project.id)}`;
}

function isTaskLogs(value: unknown): value is TaskLogs {
	if (!value || typeof value !== "object") return false;
	const phases = (value as { phases?: unknown }).phases;
	return !!phases && typeof phases === "object";
}

/** The card's build log; `null` while no run has written one. */
export async function serverCardLogs(
	project: Project,
	cardId: string,
): Promise<IPCResult<TaskLogs | null>> {
	const result = await authedFetch<{ logs?: unknown }>(logsUrl(project, cardId), "GET");
	if (!result.ok) return { success: false, error: result.error };
	const logs = result.data?.logs;
	return { success: true, data: isTaskLogs(logs) ? logs : null };
}

interface Watch {
	timer: ReturnType<typeof setInterval>;
	last: string;
}

const watches = new Map<string, Watch>();

/**
 * Read the card's log again every {@link SERVER_LOGS_POLL_MS} until
 * {@link unwatchServerCardLogs}; `emit` gets the logs each time they change.
 * Watching a card already watched restarts its watch.
 */
export function watchServerCardLogs(
	project: Project,
	cardId: string,
	emit: (cardId: string, logs: TaskLogs) => void,
): void {
	unwatchServerCardLogs(cardId);
	const watch: Watch = {
		last: "",
		timer: setInterval(() => {
			void (async () => {
				const result = await serverCardLogs(project, cardId);
				if (!result.success || !result.data) return;
				if (watches.get(cardId) !== watch) return;
				const text = JSON.stringify(result.data);
				if (text === watch.last) return;
				watch.last = text;
				emit(cardId, result.data);
			})();
		}, SERVER_LOGS_POLL_MS),
	};
	watches.set(cardId, watch);
}

/** Stop reading a card's log again; nothing when it was not watched. */
export function unwatchServerCardLogs(cardId: string): void {
	const watch = watches.get(cardId);
	if (!watch) return;
	clearInterval(watch.timer);
	watches.delete(cardId);
}

/** Every watch stopped (sign-out, window closed). */
export function unwatchAllServerCardLogs(): void {
	for (const cardId of [...watches.keys()]) unwatchServerCardLogs(cardId);
}
