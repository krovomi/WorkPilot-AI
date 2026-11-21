/**
 * The work items an import side panel shows, read through the main process.
 *
 * When the panel opens (or the project changes while it is open), the
 * connection is checked once, then the list is read unless the one kept for
 * this project is less than five minutes old. Nothing runs again on a
 * re-render, and an answer for a project the panel has since left is dropped.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { IPCResult } from "../../../shared/types";
import { CACHE_DURATION_MS, readCachedItems, writeCachedItems } from "./panel-storage";

export interface SourceStatus {
	readonly connected: boolean;
	readonly error?: string;
}

export interface SourceMessages {
	readonly notConfigured: string;
	readonly checkFailed: string;
	readonly loadFailed: string;
	readonly unknown: string;
}

export interface WorkItemSourceOptions<T, S extends SourceStatus> {
	readonly open: boolean;
	/** One per project: the list kept for it, and what re-checks the connection. */
	readonly cacheKey: string;
	readonly checkConnection: () => Promise<IPCResult<S>>;
	readonly listItems: () => Promise<IPCResult<T[]>>;
	readonly messages: SourceMessages;
}

export interface WorkItemSource<T, S extends SourceStatus = SourceStatus> {
	readonly status: S | null;
	readonly items: T[];
	readonly addItem: (item: T, sameItem: (a: T, b: T) => boolean) => void;
	readonly error: string | null;
	readonly loading: boolean;
	readonly refreshing: boolean;
	readonly refresh: () => Promise<void>;
}

const failure = (err: unknown, unknown: string) => (err instanceof Error ? err.message : unknown);

export function useWorkItemSource<T, S extends SourceStatus>(
	options: WorkItemSourceOptions<T, S>,
): WorkItemSource<T, S> {
	const { open, cacheKey } = options;
	const latest = useRef(options);
	latest.current = options;

	const [status, setStatus] = useState<S | null>(null);
	const [items, setItems] = useState<T[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const cacheTime = useRef(0);
	// Each read takes a number; only the latest one may write its answer.
	const generation = useRef(0);

	useEffect(() => {
		const cached = readCachedItems<T>(cacheKey);
		setItems(cached?.items ?? []);
		cacheTime.current = cached?.time ?? 0;
		setStatus(null);
	}, [cacheKey]);

	const load = useCallback(async (key: string, ticket: number) => {
		setLoading(true);
		setError(null);
		try {
			const result = await latest.current.listItems();
			if (ticket !== generation.current) return;
			if (result.success) {
				const list = result.data ?? [];
				const now = Date.now();
				setItems(list);
				cacheTime.current = now;
				writeCachedItems(key, list, now);
			} else {
				setError(result.error || latest.current.messages.loadFailed);
			}
		} catch (err) {
			if (ticket === generation.current) setError(failure(err, latest.current.messages.unknown));
		} finally {
			if (ticket === generation.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!open) return;
		const ticket = ++generation.current;
		void (async () => {
			try {
				const result = await latest.current.checkConnection();
				if (ticket !== generation.current) return;
				if (!result.success) {
					setError(result.error || latest.current.messages.checkFailed);
					return;
				}
				setStatus(result.data ?? null);
				if (!result.data?.connected) {
					setError(result.data?.error || latest.current.messages.notConfigured);
					return;
				}
				setError(null);
				if (Date.now() - cacheTime.current < CACHE_DURATION_MS) return;
				await load(cacheKey, ticket);
			} catch (err) {
				if (ticket === generation.current) setError(failure(err, latest.current.messages.unknown));
			}
		})();
		return () => {
			generation.current++;
			setLoading(false);
		};
	}, [open, cacheKey, load]);

	const refresh = useCallback(async () => {
		const ticket = ++generation.current;
		setRefreshing(true);
		try {
			await load(cacheKey, ticket);
		} finally {
			setRefreshing(false);
		}
	}, [cacheKey, load]);

	const addItem = useCallback((item: T, sameItem: (a: T, b: T) => boolean) => {
		setItems((prev) => (prev.some((known) => sameItem(known, item)) ? prev : [item, ...prev]));
	}, []);

	return { status, items, addItem, error, loading, refreshing, refresh };
}
