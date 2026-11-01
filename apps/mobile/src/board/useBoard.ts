/**
 * A project's board on screen: its cards, read again whenever the live
 * stream says a card changed, every 15 seconds while the stream is open
 * (it does not announce each step of a build) and every 5 while it is not.
 * A failed read keeps the cards shown. Everything stops when the screen
 * leaves or the app goes to the background.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { streamBase } from "../api/server-url";
import type { BoardCard } from "../api/types";
import { useSession } from "../auth/session";
import { BOARD_EVENTS, channelUrl, parseStreamEvent, reconnectDelay } from "./stream";

const LIVE_POLL_MS = 15_000;
const OFFLINE_POLL_MS = 5_000;
const CHANGE_DEBOUNCE_MS = 300;

type HeaderSocket = new (
	url: string,
	protocols: string | string[] | undefined,
	options: { headers: Record<string, string> },
) => WebSocket;

export interface BoardState {
	cards: BoardCard[] | null;
	error: unknown;
	live: boolean;
	refreshing: boolean;
	reload(): Promise<void>;
}

export function useBoard(projectId: string): BoardState {
	const { api, client, serverUrl } = useSession();
	const [cards, setCards] = useState<BoardCard[] | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [live, setLive] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [active, setActive] = useState(AppState.currentState === "active");
	const inFlight = useRef(false);

	const read = useCallback(async () => {
		if (!api || inFlight.current) return;
		inFlight.current = true;
		try {
			setCards(await api.cards(projectId));
			setError(null);
		} catch (err) {
			setError(err);
		} finally {
			inFlight.current = false;
		}
	}, [api, projectId]);

	const reload = useCallback(async () => {
		setRefreshing(true);
		await read();
		setRefreshing(false);
	}, [read]);

	useEffect(() => {
		const sub = AppState.addEventListener("change", (state) => setActive(state === "active"));
		return () => sub.remove();
	}, []);

	// The periodic read, shorter while the stream is down.
	useEffect(() => {
		if (!active) return;
		void read();
		const timer = setInterval(() => void read(), live ? LIVE_POLL_MS : OFFLINE_POLL_MS);
		return () => clearInterval(timer);
	}, [active, live, read]);

	// The live stream.
	useEffect(() => {
		if (!active || !api || !client || !serverUrl) return;
		let stopped = false;
		let socket: WebSocket | null = null;
		let attempt = 0;
		let reconnect: ReturnType<typeof setTimeout> | null = null;
		let debounce: ReturnType<typeof setTimeout> | null = null;

		const retry = () => {
			if (stopped || reconnect) return;
			reconnect = setTimeout(() => {
				reconnect = null;
				void open();
			}, reconnectDelay(attempt));
			attempt += 1;
		};

		const open = async () => {
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
				setLive(true);
				void read();
			};
			current.onmessage = (message) => {
				const event = parseStreamEvent(message.data);
				if (!event || !BOARD_EVENTS.has(event.type)) return;
				if (debounce) clearTimeout(debounce);
				debounce = setTimeout(() => void read(), CHANGE_DEBOUNCE_MS);
			};
			current.onclose = () => {
				if (socket !== current) return;
				socket = null;
				setLive(false);
				retry();
			};
		};

		void open();
		return () => {
			stopped = true;
			if (reconnect) clearTimeout(reconnect);
			if (debounce) clearTimeout(debounce);
			const current = socket;
			socket = null;
			current?.close();
			setLive(false);
		};
	}, [active, api, client, serverUrl, projectId, read]);

	return { cards, error, live, refreshing, reload };
}
