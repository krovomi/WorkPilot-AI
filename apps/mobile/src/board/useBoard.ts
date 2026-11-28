/**
 * A project's board on screen: its cards, read again whenever the live
 * stream says a card changed, every 15 seconds while the stream is open
 * (it does not announce each step of a build) and every 5 while it is not.
 * A failed read keeps the cards shown. Everything stops when the screen
 * leaves or the app goes to the background.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardCard } from "../api/types";
import { useSession } from "../auth/session";
import { useAppActive } from "../project/useAppActive";
import { useProjectSocket } from "../project/useProjectSocket";
import { BOARD_EVENTS } from "./stream";

const LIVE_POLL_MS = 15_000;
const OFFLINE_POLL_MS = 5_000;
const CHANGE_DEBOUNCE_MS = 300;

export interface BoardState {
	cards: BoardCard[] | null;
	error: unknown;
	live: boolean;
	refreshing: boolean;
	reload(): Promise<void>;
}

export function useBoard(projectId: string): BoardState {
	const { api } = useSession();
	const [cards, setCards] = useState<BoardCard[] | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [refreshing, setRefreshing] = useState(false);
	const active = useAppActive();
	const inFlight = useRef(false);
	const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

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

	const { live } = useProjectSocket(projectId, active, {
		onOpen: () => void read(),
		onEvent: (event) => {
			if (!BOARD_EVENTS.has(event.type)) return;
			if (debounce.current) clearTimeout(debounce.current);
			debounce.current = setTimeout(() => void read(), CHANGE_DEBOUNCE_MS);
		},
	});

	// A change announced just before the screen left is not read.
	useEffect(
		() => () => {
			if (debounce.current) clearTimeout(debounce.current);
		},
		[],
	);

	// The periodic read, shorter while the stream is down.
	useEffect(() => {
		if (!active) return;
		void read();
		const timer = setInterval(() => void read(), live ? LIVE_POLL_MS : OFFLINE_POLL_MS);
		return () => clearInterval(timer);
	}, [active, live, read]);

	return { cards, error, live, refreshing, reload };
}
