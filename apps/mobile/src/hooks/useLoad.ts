/** Load something once a screen shows, with pull-to-refresh and the last error. */

import { useCallback, useEffect, useState } from "react";

export interface Loaded<T> {
	data: T | null;
	error: unknown;
	loading: boolean;
	refreshing: boolean;
	reload(): Promise<void>;
}

export function useLoad<T>(load: () => Promise<T>): Loaded<T> {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);

	const run = useCallback(async () => {
		try {
			setData(await load());
			setError(null);
		} catch (err) {
			setError(err);
		}
	}, [load]);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void run().finally(() => {
			if (!cancelled) setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, [run]);

	const reload = useCallback(async () => {
		setRefreshing(true);
		await run();
		setRefreshing(false);
	}, [run]);

	return { data, error, loading, refreshing, reload };
}
