import { create } from "zustand";
import type { SidebarView } from "@/components/Sidebar";

/**
 * How often, and for how long, each page of the left menu is actually used.
 *
 * Audit finding F19 (78 views) says nothing may be removed or regrouped
 * without usage data. This store is that data: a visit counter and a dwell
 * time per view, kept in this browser profile only. Nothing leaves the
 * machine — the maintainer reads it from Settings → Debug and decides.
 */

export interface ViewUsage {
	visits: number;
	/** Milliseconds the page was on screen, summed over all visits. */
	dwellMs: number;
	lastVisitedAt: number;
}

export type ViewUsageMap = Partial<Record<SidebarView, ViewUsage>>;

const STORAGE_KEY = "workpilot.viewUsage.v1";

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

interface ViewUsageState {
	usage: ViewUsageMap;
	current: { view: SidebarView; since: number } | null;
	/** The page on screen changed. Closes the previous visit, opens this one. */
	enter: (view: SidebarView | null, now?: number) => void;
	reset: () => void;
}

export const useViewUsageStore = create<ViewUsageState>((set, get) => ({
	usage: load(),
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

	reset: () => {
		save({});
		set({ usage: {}, current: null });
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
