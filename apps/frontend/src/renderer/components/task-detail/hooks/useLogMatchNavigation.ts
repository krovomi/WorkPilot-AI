import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { LOG_VIEWPORT_DETACH_EVENT } from "../../../lib/follow-log-viewport";

/**
 * Each rendered log entry that matches the active search/filters carries this
 * attribute; its value identifies the entry, so the current match survives a
 * re-render (new live entries, reverse order) instead of shifting by index.
 */
export const LOG_MATCH_ATTR = "data-log-match";
/** Set on the current match only, for the ring and the stronger highlight. */
export const LOG_MATCH_ACTIVE_ATTR = "data-active-match";

interface Options {
	containerRef: React.RefObject<HTMLElement | null>;
	/** False while no search or filter is active: no counter, no current match. */
	enabled: boolean;
	/** Changes whenever the query or a filter changes: navigation starts over. */
	resetKey: string;
	/** On reset, select the first match and scroll to it (a text search does,
	 * a filter alone only narrows the list). */
	selectFirstOnReset: boolean;
}

export interface LogMatchNavigation {
	/** Matches rendered right now. */
	total: number;
	/** 0-based position of the current match, -1 when none is selected. */
	current: number;
	next: () => void;
	previous: () => void;
}

/**
 * Jump between the matches of the log search, in on-screen order.
 *
 * Matches are read from the DOM rather than recomputed from the data: what the
 * reader sees (per-LLM file, model groups, reverse order, phase filter) decides
 * the order and the count, so "3/12" always points at the third visible hit.
 */
export function useLogMatchNavigation({
	containerRef,
	enabled,
	resetKey,
	selectFirstOnReset,
}: Options): LogMatchNavigation {
	const [total, setTotal] = useState(0);
	const [current, setCurrent] = useState(-1);
	// Rendering is not needed to move: the layout effect reads these refs.
	const activeKeyRef = useRef<string | null>(null);
	const currentRef = useRef(-1);
	const pendingScrollRef = useRef(false);
	const resetRef = useRef(true);
	const [tick, setTick] = useState(0);

	// What the last sync saw; a different value means the search changed.
	const lastResetKeyRef = useRef<string | null>(null);

	// After every render (no dependency list on purpose: the match list lives
	// in the DOM): recount, find the current match again by its key, mark it,
	// and scroll to it when a jump is pending.
	useLayoutEffect(() => {
		const resetSignature = `${enabled}|${resetKey}`;
		if (lastResetKeyRef.current !== resetSignature) {
			lastResetKeyRef.current = resetSignature;
			activeKeyRef.current = null;
			currentRef.current = -1;
			resetRef.current = true;
		}
		const container = containerRef.current;
		for (const el of container?.querySelectorAll(`[${LOG_MATCH_ACTIVE_ATTR}]`) ??
			[]) {
			el.removeAttribute(LOG_MATCH_ACTIVE_ATTR);
		}
		const matches =
			enabled && container
				? Array.from(container.querySelectorAll<HTMLElement>(`[${LOG_MATCH_ATTR}]`))
				: [];

		let index = -1;
		if (matches.length > 0) {
			if (resetRef.current) {
				index = selectFirstOnReset ? 0 : -1;
				pendingScrollRef.current = selectFirstOnReset;
			} else if (activeKeyRef.current !== null) {
				index = matches.findIndex(
					(el) => el.getAttribute(LOG_MATCH_ATTR) === activeKeyRef.current,
				);
				// The current entry left the list (filtered out): keep the position.
				if (index === -1) {
					index = Math.min(Math.max(currentRef.current, 0), matches.length - 1);
				}
			}
		}
		resetRef.current = false;

		const active = index >= 0 ? matches[index] : undefined;
		activeKeyRef.current = active?.getAttribute(LOG_MATCH_ATTR) ?? null;
		currentRef.current = index;
		if (active) {
			active.setAttribute(LOG_MATCH_ACTIVE_ATTR, "true");
			if (pendingScrollRef.current && container) {
				scrollMatchIntoView(container, active);
			}
		}
		pendingScrollRef.current = false;

		setTotal((prev) => (prev === matches.length ? prev : matches.length));
		setCurrent((prev) => (prev === index ? prev : index));
	});

	const move = useCallback(
		(delta: 1 | -1) => {
			const container = containerRef.current;
			if (!enabled || !container) return;
			const count = container.querySelectorAll(`[${LOG_MATCH_ATTR}]`).length;
			if (count === 0) return;
			const from = currentRef.current;
			const index =
				from < 0
					? delta > 0
						? 0
						: count - 1
					: (from + delta + count) % count;
			const el = container.querySelectorAll<HTMLElement>(`[${LOG_MATCH_ATTR}]`)[
				index
			];
			activeKeyRef.current = el?.getAttribute(LOG_MATCH_ATTR) ?? null;
			currentRef.current = index;
			pendingScrollRef.current = true;
			setTick((n) => n + 1);
		},
		[containerRef, enabled],
	);

	// `tick` only forces the render that runs the sync effect.
	void tick;

	return {
		total: enabled ? total : 0,
		current: enabled ? current : -1,
		next: useCallback(() => move(1), [move]),
		previous: useCallback(() => move(-1), [move]),
	};
}

/** Center the match in the log viewport (top-aligned when taller than it). */
function scrollMatchIntoView(container: HTMLElement, el: HTMLElement): void {
	const box = container.getBoundingClientRect();
	const rect = el.getBoundingClientRect();
	const offset = rect.top - box.top;
	const centered =
		rect.height >= container.clientHeight
			? offset - 8
			: offset - (container.clientHeight - rect.height) / 2;
	// Stop the "follow new output" behaviour first, or the next live batch
	// would pull the viewport straight back to the edge.
	container.dispatchEvent(new Event(LOG_VIEWPORT_DETACH_EVENT));
	container.scrollTo({
		top: Math.max(0, container.scrollTop + centered),
		behavior: "smooth",
	});
}
