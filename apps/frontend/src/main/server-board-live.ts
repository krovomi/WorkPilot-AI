/**
 * The live stream of a server board (server mode). While a server project's
 * board is shown, the main process holds a WebSocket on the project's
 * channel (`project:<id>`) and tells the window when a card changes, so a
 * teammate's change appears at once instead of at the next read.
 *
 * The access token goes in the `Authorization` header, never in the URL, and
 * stays in the main process: the window only learns that the board changed
 * and whether the stream is up. The server decides who may open the channel
 * (members of the project); a refusal leaves the board on its periodic read.
 */

import { getServerProject } from "./server-projects";
import { authedFetch, getAccessToken, getActiveOrgId, getServerUrl } from "./server-connection";

/** The stream's port when the server names no other address. */
export const DEFAULT_STREAM_PORT = 8765;
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
const RECONNECT_MS = [2_000, 5_000, 15_000, 30_000];
const CHANGE_DEBOUNCE_MS = 300;

export interface LiveBoardUpdate {
	projectId: string;
	/** Whether the stream is open: the window reads less often while it is. */
	live: boolean;
	/** A card changed: read the board now. */
	changed: boolean;
}

type Notify = (update: LiveBoardUpdate) => void;

interface Watch {
	notify: Notify;
	socket: WebSocket | null;
	attempt: number;
	reconnect: ReturnType<typeof setTimeout> | null;
	debounce: ReturnType<typeof setTimeout> | null;
	stopped: boolean;
}

const watches = new Map<string, Watch>();

/**
 * The stream's base URL: the one the server names, else the API's host on
 * the stream's port, `wss` behind `https`.
 */
export function streamBase(serverUrl: string, advertised: unknown): string | null {
	if (typeof advertised === "string" && /^wss?:\/\/[^\s]+$/.test(advertised)) {
		return advertised.replace(/\/+$/, "");
	}
	try {
		const api = new URL(serverUrl);
		if (api.protocol !== "http:" && api.protocol !== "https:") return null;
		const scheme = api.protocol === "https:" ? "wss:" : "ws:";
		return `${scheme}//${api.hostname}:${DEFAULT_STREAM_PORT}`;
	} catch {
		return null;
	}
}

/** Whether a message from the stream says a card of the board changed. */
export function isBoardChange(raw: unknown): boolean {
	if (typeof raw !== "string" || raw.length > 64_000) return false;
	try {
		const message = JSON.parse(raw) as { event_type?: unknown };
		return typeof message?.event_type === "string" && BOARD_EVENTS.has(message.event_type);
	} catch {
		return false;
	}
}

async function open(projectId: string, watch: Watch): Promise<void> {
	const serverUrl = getServerUrl();
	if (watch.stopped || !serverUrl || !getServerProject(projectId)) return;
	// Also refreshes an expired access token before the handshake.
	const where = await authedFetch<{ url?: unknown }>("/api/board/stream", "GET");
	const token = getAccessToken();
	const base = streamBase(serverUrl, where.ok ? where.data?.url : null);
	if (watch.stopped) return;
	if (!where.ok || !token || !base) {
		retry(projectId, watch);
		return;
	}
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	const org = getActiveOrgId();
	if (org) headers["X-WorkPilot-Org"] = org;
	const url = `${base}/stream/${encodeURIComponent(`project:${projectId}`)}`;
	// Electron's WebSocket (undici) takes headers as a non-standard option.
	const Socket = WebSocket as unknown as new (
		url: string,
		init: { headers: Record<string, string> },
	) => WebSocket;
	let socket: WebSocket;
	try {
		socket = new Socket(url, { headers });
	} catch {
		retry(projectId, watch);
		return;
	}
	watch.socket = socket;
	socket.onopen = () => {
		watch.attempt = 0;
		// A change may have happened while the stream was down.
		watch.notify({ projectId, live: true, changed: true });
	};
	socket.onmessage = (event) => {
		if (!isBoardChange(event.data)) return;
		if (watch.debounce) clearTimeout(watch.debounce);
		watch.debounce = setTimeout(() => {
			watch.debounce = null;
			if (!watch.stopped) watch.notify({ projectId, live: true, changed: true });
		}, CHANGE_DEBOUNCE_MS);
	};
	socket.onclose = () => {
		if (watch.socket !== socket) return;
		watch.socket = null;
		if (watch.stopped) return;
		watch.notify({ projectId, live: false, changed: false });
		retry(projectId, watch);
	};
	socket.onerror = () => {
		// onclose follows and retries.
	};
}

function retry(projectId: string, watch: Watch): void {
	if (watch.stopped || watch.reconnect) return;
	const delay = RECONNECT_MS[Math.min(watch.attempt, RECONNECT_MS.length - 1)];
	watch.attempt += 1;
	watch.reconnect = setTimeout(() => {
		watch.reconnect = null;
		void open(projectId, watch);
	}, delay);
}

/** Follow a server board's changes; replaces an earlier watch of it. */
export function watchServerBoard(projectId: unknown, notify: Notify): boolean {
	if (typeof projectId !== "string" || !getServerProject(projectId)) return false;
	unwatchServerBoard(projectId);
	const watch: Watch = {
		notify,
		socket: null,
		attempt: 0,
		reconnect: null,
		debounce: null,
		stopped: false,
	};
	watches.set(projectId, watch);
	void open(projectId, watch);
	return true;
}

export function unwatchServerBoard(projectId: unknown): void {
	if (typeof projectId !== "string") return;
	const watch = watches.get(projectId);
	if (!watch) return;
	watches.delete(projectId);
	watch.stopped = true;
	if (watch.reconnect) clearTimeout(watch.reconnect);
	if (watch.debounce) clearTimeout(watch.debounce);
	watch.socket?.close();
	watch.socket = null;
}

/** Close every stream (sign-out, another server, the window closing). */
export function unwatchAllServerBoards(): void {
	for (const projectId of [...watches.keys()]) unwatchServerBoard(projectId);
}
