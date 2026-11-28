/**
 * A server card's published copies, read from the server (server mode).
 *
 * The app's mirror of a server card holds its `publication.json` and
 * `pr-sync.json` (`remote-board.ts`), never an image: the server keeps them in
 * its clone and serves one published copy at a time, named by its place in
 * the publication and its side (`GET /api/board/cards/{id}/captures/{index}/{side}`,
 * `apps/backend/shared_board/captures.py`). The renderer still names a file
 * the publication lists; it becomes that place here, and nothing else from
 * the renderer reaches the request.
 */

import type { TaskCapturesSummary } from "../../shared/types/task-captures";
import type { ServerCard } from "../server-board-actions";
import { authedFetch } from "../server-connection";
import { MAX_IMAGE_BYTES, publishedFile } from "./read-captures";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Base64 of the largest copy the app shows. */
const MAX_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

export type CaptureSide = "before" | "after";

/** Where the publication lists `file`: its screen's index and its side. */
export function capturePlace(
	summary: TaskCapturesSummary,
	file: unknown,
): { index: number; side: CaptureSide } | null {
	const name = publishedFile(file);
	if (!name) return null;
	for (const [index, item] of summary.items.entries()) {
		if (item.after?.file === name) return { index, side: "after" };
		if (item.before?.file === name) return { index, side: "before" };
	}
	return null;
}

/**
 * One published copy of a server card as base64, or an error code:
 * `not-listed`, `not-png`, `too-large`, or the server's answer.
 */
export async function readServerCaptureImage(
	card: ServerCard,
	summary: TaskCapturesSummary,
	file: unknown,
): Promise<{ base64: string } | { error: string }> {
	const place = capturePlace(summary, file);
	if (!place) return { error: "not-listed" };
	const answer = await authedFetch<{ mimeType?: unknown; data?: unknown }>(
		`/api/board/cards/${encodeURIComponent(card.cardId)}/captures/${place.index}/${place.side}` +
			`?project_id=${encodeURIComponent(card.project.id)}`,
		"GET",
	);
	if (!answer.ok) return { error: answer.error };
	const data = answer.data?.data;
	if (typeof data !== "string" || !data) return { error: "unreadable" };
	if (data.length > MAX_BASE64) return { error: "too-large" };
	const bytes = Buffer.from(data, "base64");
	if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
		return { error: "not-png" };
	}
	return { base64: bytes.toString("base64") };
}
