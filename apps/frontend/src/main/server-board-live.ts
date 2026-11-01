/**
 * The live board of a server project (server mode). While a server project's
 * board is shown, it holds the project's stream (`server-project-stream.ts`,
 * `project:<id>`) and tells the window when a card changes, so a teammate's
 * change appears at once instead of at the next read.
 *
 * The window only learns that the board changed and whether the stream is
 * up; the token and the stream stay in the main process. A refused or
 * dropped stream leaves the board on its periodic read.
 */

import {
	DEFAULT_STREAM_PORT,
	holdProjectStream,
	parseStreamEvent,
	streamBase,
} from "./server-project-stream";
import { getServerProject } from "./server-projects";

export { DEFAULT_STREAM_PORT, streamBase };

/** Events that change what a server board shows. */
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
const CHANGE_DEBOUNCE_MS = 300;

export interface LiveBoardUpdate {
	projectId: string;
	/** Whether the stream is open: the window reads less often while it is. */
	live: boolean;
	/** A card changed: read the board now. */
	changed: boolean;
}

type Notify = (update: LiveBoardUpdate) => void;

interface Board {
	release: (() => void) | null;
	debounce: ReturnType<typeof setTimeout> | null;
}

const boards = new Map<string, Board>();

/** Whether a message from the stream says a card of the board changed. */
export function isBoardChange(raw: unknown): boolean {
	const event = parseStreamEvent(raw);
	return !!event && BOARD_EVENTS.has(event.type);
}

/** Follow a server board's changes; replaces an earlier watch of it. */
export function watchServerBoard(projectId: unknown, notify: Notify): boolean {
	if (typeof projectId !== "string" || !getServerProject(projectId)) return false;
	unwatchServerBoard(projectId);
	const board: Board = { release: null, debounce: null };
	boards.set(projectId, board);
	board.release = holdProjectStream(projectId, {
		// Opened: a change may have happened while it was down. Dropped: the
		// window reads on its shorter timer.
		onLive: (live) => notify({ projectId, live, changed: live }),
		onEvent: (event) => {
			if (!BOARD_EVENTS.has(event.type)) return;
			if (board.debounce) clearTimeout(board.debounce);
			board.debounce = setTimeout(() => {
				board.debounce = null;
				if (boards.get(projectId) === board) {
					notify({ projectId, live: true, changed: true });
				}
			}, CHANGE_DEBOUNCE_MS);
		},
	});
	if (!board.release) {
		boards.delete(projectId);
		return false;
	}
	return true;
}

export function unwatchServerBoard(projectId: unknown): void {
	if (typeof projectId !== "string") return;
	const board = boards.get(projectId);
	if (!board) return;
	boards.delete(projectId);
	if (board.debounce) clearTimeout(board.debounce);
	board.release?.();
}

/** Stop following every board (sign-out, another server, the window closing). */
export function unwatchAllServerBoards(): void {
	for (const projectId of [...boards.keys()]) unwatchServerBoard(projectId);
}
