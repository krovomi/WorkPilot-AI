/**
 * The live stream of a project (`project:<id>` on the server's WebSocket):
 * the phone learns that a teammate created, moved or approved a card and
 * reads the board again. Opening it is `project/useProjectSocket.ts`.
 */

/** Events that change what a board shows (as `server-board-live.ts`). */
export const BOARD_EVENTS = new Set([
	"project_updated",
	"spec_created",
	"spec_updated",
	"spec_deleted",
	"spec_approved",
	"spec_claimed",
	"spec_released",
	"spec_status_changed",
]);

export const RECONNECT_MS = [2_000, 5_000, 15_000, 30_000] as const;
const MAX_MESSAGE = 64_000;

export interface StreamEvent {
	type: string;
	data: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A message of the stream read as an event; null for anything else, or longer than `max`. */
export function parseStreamEvent(raw: unknown, max = MAX_MESSAGE): StreamEvent | null {
	if (typeof raw !== "string" || raw.length > max) return null;
	try {
		const message: unknown = JSON.parse(raw);
		if (!isRecord(message) || typeof message.event_type !== "string") return null;
		return { type: message.event_type, data: isRecord(message.data) ? message.data : {} };
	} catch {
		return null;
	}
}

/** The URL of a project's channel on the stream. */
export function channelUrl(base: string, projectId: string): string {
	return `${base}/stream/${encodeURIComponent(`project:${projectId}`)}`;
}

/** The wait before the n-th reconnection (0-based). */
export function reconnectDelay(attempt: number): number {
	return RECONNECT_MS[Math.min(Math.max(attempt, 0), RECONNECT_MS.length - 1)];
}
