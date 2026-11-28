/**
 * One view of `/admin/usage/*`, read again whenever the period, a filter or
 * the scope changes; an answer that arrives after a newer question is dropped.
 */
import { useEffect, useState } from "react";
import type { UsageQuery, UsageResult, UsageView } from "@shared/types/server-usage";

export interface Loaded<T> {
	data: T | null;
	error: string | null;
	loading: boolean;
}

function bridge() {
	return globalThis.electronAPI?.serverUsage ?? null;
}

/** `tick` asks again with the same question (after a change on the server). */
export function useUsageView<T>(view: UsageView, query: UsageQuery, tick = 0): Loaded<T> {
	const [state, setState] = useState<Loaded<T>>({ data: null, error: null, loading: true });
	const key = JSON.stringify(query);
	useEffect(() => {
		const api = bridge();
		if (!api) return;
		let live = true;
		setState((s) => ({ ...s, loading: true }));
		void api
			.getUsageView<T>(view, JSON.parse(key) as UsageQuery)
			.then((result: UsageResult<T>) => {
				if (!live) return;
				setState(
					result.ok
						? { data: result.data, error: null, loading: false }
						: { data: null, error: result.error, loading: false },
				);
			});
		return () => {
			live = false;
		};
	}, [view, key, tick]);
	return state;
}
