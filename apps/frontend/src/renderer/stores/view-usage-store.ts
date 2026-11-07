import { create } from "zustand";
import type { SidebarView } from "@/components/Sidebar";

/**
 * How often, and for how long, each page of the left menu is actually used.
 *
 * Audit finding F19 (78 views) says nothing may be removed or regrouped
 * without usage data. This store is that data: a visit counter and a dwell
 * time per view, kept in this browser profile only. Nothing leaves the
 * machine — the maintainer reads it from Settings → Debug, or exports it as
 * JSON there (plan of 29 October, T5), and decides.
 */

export interface ViewUsage {
	visits: number;
	/** Milliseconds the page was on screen, summed over all visits. */
	dwellMs: number;
	lastVisitedAt: number;
}

export type ViewUsageMap = Partial<Record<SidebarView, ViewUsage>>;

const STORAGE_KEY = "workpilot.viewUsage.v1";
/** When counting started (first load, or the last reset): "never opened" means
 * nothing without it. */
const SINCE_KEY = "workpilot.viewUsage.since";

/** A page left on screen overnight is not eight hours of use. */
const MAX_DWELL_MS = 30 * 60 * 1000;

function load(): ViewUsageMap {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? (JSON.parse(raw) as ViewUsageMap) : {};
	} catch {
		return {};
	}
}

function save(usage: ViewUsageMap): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(usage));
	} catch {
		// Private window or blocked storage: usage is simply not kept.
	}
}

function loadSince(now = Date.now()): number {
	try {
		const raw = Number(localStorage.getItem(SINCE_KEY));
		if (Number.isFinite(raw) && raw > 0) return raw;
		localStorage.setItem(SINCE_KEY, String(now));
	} catch {
		// Blocked storage: the counter starts with this session.
	}
	return now;
}

function saveSince(since: number): void {
	try {
		localStorage.setItem(SINCE_KEY, String(since));
	} catch {
		// Blocked storage: see save().
	}
}

interface ViewUsageState {
	usage: ViewUsageMap;
	/** When counting started, in milliseconds since the epoch. */
	since: number;
	current: { view: SidebarView; since: number } | null;
	/** The page on screen changed. Closes the previous visit, opens this one. */
	enter: (view: SidebarView | null, now?: number) => void;
	reset: (now?: number) => void;
}

export const useViewUsageStore = create<ViewUsageState>((set, get) => ({
	usage: load(),
	since: loadSince(),
	current: null,

	enter: (view, now = Date.now()) => {
		const { current, usage } = get();
		if (current && view === current.view) return;
		const next: ViewUsageMap = { ...usage };
		if (current) {
			const prev = next[current.view] ?? {
				visits: 0,
				dwellMs: 0,
				lastVisitedAt: now,
			};
			next[current.view] = {
				...prev,
				dwellMs:
					prev.dwellMs + Math.min(Math.max(now - current.since, 0), MAX_DWELL_MS),
			};
		}
		if (view) {
			const prev = next[view] ?? { visits: 0, dwellMs: 0, lastVisitedAt: now };
			next[view] = { ...prev, visits: prev.visits + 1, lastVisitedAt: now };
		}
		save(next);
		set({ usage: next, current: view ? { view, since: now } : null });
	},

	reset: (now = Date.now()) => {
		save({});
		saveSince(now);
		set({ usage: {}, since: now, current: null });
	},
}));

export const recordViewVisit = (view: SidebarView | null): void =>
	useViewUsageStore.getState().enter(view);

/** One row per view, most visited first — the shape the Debug panel prints. */
export function rankViewUsage(
	usage: ViewUsageMap,
): Array<{ view: SidebarView } & ViewUsage> {
	return (Object.entries(usage) as Array<[SidebarView, ViewUsage]>)
		.map(([view, u]) => ({ view, ...u }))
		.sort((a, b) => b.visits - a.visits || b.dwellMs - a.dwellMs);
}

export interface ViewUsageReport {
	version: 1;
	exportedAt: string;
	/** When counting started: a view at zero has not been opened since then. */
	countingSince: string;
	/** Every view with at least one visit, most visited first. */
	views: Array<{ view: SidebarView } & ViewUsage>;
	/** The views marked experimental, each with its count, zero included. */
	experimental: Array<{ view: SidebarView; visits: number; dwellMs: number }>;
	/** The experimental views not opened once since `countingSince`. */
	neverOpened: SidebarView[];
}

/**
 * The export of Settings → Debug: the data the removal of experimental views
 * is decided on (plan of 29 October, T5). Pure, so the panel and a test read
 * the same thing.
 */
export function buildViewUsageReport(
	usage: ViewUsageMap,
	since: number,
	experimental: Iterable<SidebarView>,
	now = Date.now(),
): ViewUsageReport {
	const rows = [...experimental]
		.map((view) => ({
			view,
			visits: usage[view]?.visits ?? 0,
			dwellMs: usage[view]?.dwellMs ?? 0,
		}))
		.sort(
			(a, b) =>
				b.visits - a.visits ||
				b.dwellMs - a.dwellMs ||
				a.view.localeCompare(b.view),
		);
	return {
		version: 1,
		exportedAt: new Date(now).toISOString(),
		countingSince: new Date(since).toISOString(),
		views: rankViewUsage(usage),
		experimental: rows,
		neverOpened: rows.filter((row) => row.visits === 0).map((row) => row.view),
	};
}
