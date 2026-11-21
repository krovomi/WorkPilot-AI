/**
 * A work item asked for by its key or number that is not in the loaded list
 * is read on its own (after a short pause in typing), so any item can be
 * found, including types and items outside the listed window. A failed
 * lookup leaves the list as it is; an answer for a key no longer asked for
 * is dropped.
 */
import { useEffect, useRef, useState } from "react";
import type { IPCResult } from "../../../shared/types";

export const LOOKUP_DELAY_MS = 400;

/** `key` is null when there is nothing to look up. Returns whether a lookup is running. */
export function useDirectLookup<K, T>(
	key: K | null,
	fetchItem: (key: K) => Promise<IPCResult<T>>,
	onFound: (item: T) => void,
): boolean {
	const [searching, setSearching] = useState(false);
	const latest = useRef({ fetchItem, onFound });
	latest.current = { fetchItem, onFound };

	useEffect(() => {
		if (key === null) return;
		let cancelled = false;
		const handle = setTimeout(async () => {
			setSearching(true);
			try {
				const result = await latest.current.fetchItem(key);
				if (!cancelled && result.success && result.data) latest.current.onFound(result.data);
			} catch {
				// Unknown key, no access, unreachable: the item is simply not found.
			} finally {
				if (!cancelled) setSearching(false);
			}
		}, LOOKUP_DELAY_MS);
		return () => {
			cancelled = true;
			clearTimeout(handle);
			setSearching(false);
		};
	}, [key]);

	return searching;
}
