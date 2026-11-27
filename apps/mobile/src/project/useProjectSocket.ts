/**
 * A project's channel on the server's live stream (`project:<id>`), open
 * while the screen is shown and the app in the foreground. The board reads
 * its events; the team chat reads the room's and sends its messages on it.
 * The token goes in the `Authorization` header of the handshake (React
 * Native's WebSocket takes headers), never in the URL that a proxy logs. A
 * dropped stream is opened again after 2, 5, 15 then 30 seconds.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { streamBase } from "../api/server-url";
import { useSession } from "../auth/session";
import { channelUrl, parseStreamEvent, reconnectDelay, type StreamEvent } from "../board/stream";

/** The longest message read: the room's history is up to 100 messages of 2,000 characters. */
export const MAX_ROOM_MESSAGE = 2_000_000;

type HeaderSocket = new (
	url: string,
	protocols: string | string[] | undefined,
	options: { headers: Record<string, string> },
) => WebSocket;

export interface ProjectSocketHandlers {
	/** The stream opened (again): what it missed meanwhile is to be read. */
	onOpen?: () => void;
	onEvent: (event: StreamEvent) => void;
}

export interface ProjectSocket {
	live: boolean;
	/** Sends a message on the open stream; false when it is not open. */
	send(message: Readonly<Record<string, unknown>>): boolean;
}

export function useProjectSocket(projectId: string, active: boolean, handlers: ProjectSocketHandlers): ProjectSocket {
	const { api, client, serverUrl } = useSession();
	const [live, setLive] = useState(false);
	const latest = useRef(handlers);
	latest.current = handlers;
	const open = useRef<WebSocket | null>(null);

	useEffect(() => {
		if (!active || !api || !client || !serverUrl) return;
		let stopped = false;
		let socket: WebSocket | null = null;
		let attempt = 0;
		let reconnect: ReturnType<typeof setTimeout> | null = null;

		// Called only with no socket open and no reconnect pending, never after the
		// cleanup (`connect` checks `stopped`, and the cleanup detaches the socket first).
		const retry = () => {
			reconnect = setTimeout(() => {
				reconnect = null;
				void connect();
			}, reconnectDelay(attempt));
			attempt += 1;
		};

		const connect = async () => {
			let base: string | null = null;
			try {
				// Also refreshes an expired access token before the handshake.
				base = streamBase(serverUrl, (await api.streamInfo()).url);
			} catch {
				base = null;
			}
			const token = client.currentAccessToken;
			if (stopped) return;
			if (!base || !token) {
				retry();
				return;
			}
			const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
			if (client.activeOrgId) headers["X-WorkPilot-Org"] = client.activeOrgId;
			try {
				socket = new (WebSocket as unknown as HeaderSocket)(channelUrl(base, projectId), undefined, { headers });
			} catch {
				retry();
				return;
			}
			const current = socket;
			current.onopen = () => {
				attempt = 0;
				open.current = current;
				setLive(true);
				latest.current.onOpen?.();
			};
			current.onmessage = (message) => {
				const event = parseStreamEvent(message.data, MAX_ROOM_MESSAGE);
				if (event) latest.current.onEvent(event);
			};
			current.onclose = () => {
				if (socket !== current) return;
				socket = null;
				open.current = null;
				setLive(false);
				retry();
			};
		};

		void connect();
		return () => {
			stopped = true;
			if (reconnect) clearTimeout(reconnect);
			const current = socket;
			socket = null;
			open.current = null;
			current?.close();
			setLive(false);
		};
	}, [active, api, client, serverUrl, projectId]);

	const send = useCallback((message: Readonly<Record<string, unknown>>) => {
		const socket = open.current;
		if (!socket) return false;
		try {
			socket.send(JSON.stringify(message));
			return true;
		} catch {
			return false;
		}
	}, []);

	return { live, send };
}
