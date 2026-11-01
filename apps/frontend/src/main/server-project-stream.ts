/**
 * The live stream of a server project (server mode): one WebSocket per
 * project, on its channel (`project:<id>`), shared by everything the app
 * shows of that project: its board (`server-board-live.ts`) and its shared
 * views (`server-live-views.ts`). Each of them holds a reference; the socket
 * opens with the first and closes with the last, and a dropped one is opened
 * again while anyone still holds it.
 *
 * The access token goes in the `Authorization` header, never in the URL, and
 * stays in the main process. The server decides who may open the channel
 * (members of the project); a refusal is retried like a drop.
 */

import { authedFetch, getAccessToken, getActiveOrgId, getServerUrl } from "./server-connection";
import { getServerProject } from "./server-projects";

/** The stream's port when the server names no other address. */
export const DEFAULT_STREAM_PORT = 8765;
const RECONNECT_MS = [2_000, 5_000, 15_000, 30_000];
const MAX_MESSAGE = 64_000;

/** One event of the project's stream, as the server sent it. */
export interface StreamEvent {
	type: string;
	data: Readonly<Record<string, unknown>>;
}

/** Something the app shows of a server project, following its stream. */
export interface StreamHolder {
	/** The stream opened (true) or dropped (false). */
	onLive(live: boolean): void;
	onEvent(event: StreamEvent): void;
}

interface Stream {
	holders: Set<StreamHolder>;
	socket: WebSocket | null;
	live: boolean;
	attempt: number;
	reconnect: ReturnType<typeof setTimeout> | null;
	stopped: boolean;
}

const streams = new Map<string, Stream>();

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A message of the stream read as an event; null for anything else. */
export function parseStreamEvent(raw: unknown): StreamEvent | null {
	if (typeof raw !== "string" || raw.length > MAX_MESSAGE) return null;
	try {
		const message: unknown = JSON.parse(raw);
		if (!isRecord(message) || typeof message.event_type !== "string") return null;
		return {
			type: message.event_type,
			data: isRecord(message.data) ? message.data : {},
		};
	} catch {
		return null;
	}
}

function setLive(stream: Stream, live: boolean): void {
	stream.live = live;
	for (const holder of [...stream.holders]) holder.onLive(live);
}

async function open(projectId: string, stream: Stream): Promise<void> {
	const serverUrl = getServerUrl();
	if (stream.stopped || !serverUrl || !getServerProject(projectId)) return;
	// Also refreshes an expired access token before the handshake.
	const where = await authedFetch<{ url?: unknown }>("/api/board/stream", "GET");
	const token = getAccessToken();
	const base = streamBase(serverUrl, where.ok ? where.data?.url : null);
	if (stream.stopped) return;
	if (!where.ok || !token || !base) {
		retry(projectId, stream);
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
		retry(projectId, stream);
		return;
	}
	stream.socket = socket;
	socket.onopen = () => {
		stream.attempt = 0;
		setLive(stream, true);
	};
	socket.onmessage = (message) => {
		const event = parseStreamEvent(message.data);
		if (!event || stream.stopped) return;
		for (const holder of [...stream.holders]) holder.onEvent(event);
	};
	socket.onclose = () => {
		if (stream.socket !== socket) return;
		stream.socket = null;
		if (stream.stopped) return;
		setLive(stream, false);
		retry(projectId, stream);
	};
	socket.onerror = () => {
		// onclose follows and retries.
	};
}

function retry(projectId: string, stream: Stream): void {
	if (stream.stopped || stream.reconnect) return;
	const delay = RECONNECT_MS[Math.min(stream.attempt, RECONNECT_MS.length - 1)];
	stream.attempt += 1;
	stream.reconnect = setTimeout(() => {
		stream.reconnect = null;
		void open(projectId, stream);
	}, delay);
}

function close(projectId: string, stream: Stream): void {
	if (streams.get(projectId) === stream) streams.delete(projectId);
	stream.stopped = true;
	stream.holders.clear();
	if (stream.reconnect) clearTimeout(stream.reconnect);
	stream.reconnect = null;
	stream.socket?.close();
	stream.socket = null;
}

/**
 * Hold a server project's stream: opened if no one held it, shared
 * otherwise (a holder that joins an open stream hears that it is live).
 * Returns the release, or null for a project that is not the server's.
 */
export function holdProjectStream(
	projectId: unknown,
	holder: StreamHolder,
): (() => void) | null {
	if (typeof projectId !== "string" || !getServerProject(projectId)) return null;
	let stream = streams.get(projectId);
	const opening = !stream;
	if (!stream) {
		stream = {
			holders: new Set(),
			socket: null,
			live: false,
			attempt: 0,
			reconnect: null,
			stopped: false,
		};
		streams.set(projectId, stream);
	}
	const held = stream;
	held.holders.add(holder);
	if (opening) void open(projectId, held);
	else if (held.live) holder.onLive(true);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		held.holders.delete(holder);
		if (held.holders.size === 0) close(projectId, held);
	};
}

/** How many holders a project's stream has (0 when it is closed). */
export function streamHolders(projectId: string): number {
	return streams.get(projectId)?.holders.size ?? 0;
}

/** Close every stream (sign-out, another server). */
export function closeAllProjectStreams(): void {
	for (const [projectId, stream] of [...streams]) close(projectId, stream);
}
