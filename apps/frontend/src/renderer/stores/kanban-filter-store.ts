import { useMemo } from "react";
import { create } from "zustand";
import type { TaskCategory, TaskPriority } from "../../shared/types";
import {
	type BoardFilterContext,
	DEFAULT_SORT,
	EMPTY_FILTERS,
	type KanbanFilters,
	type KanbanSort,
	type QuickFilter,
	type TaskSortDirection,
	type TaskSortField,
	type TaskSource,
} from "../lib/kanban-filter";
import type { LaneGrouping } from "../lib/kanban-lanes";
import type { BoardLayout, ListSort } from "../lib/kanban-list";
import { useCollaborationStore } from "./collaboration-store";
import { useKanbanLanesStore } from "./kanban-lanes-store";

// ============================================
// Persistence (per-project localStorage)
// ============================================

const FILTER_KEY_PREFIX = "kanban-filters";
const VIEWS_KEY_PREFIX = "kanban-views";

function getStorageKey(projectId: string): string {
	return `${FILTER_KEY_PREFIX}-${projectId}`;
}

function getViewsStorageKey(projectId: string): string {
	return `${VIEWS_KEY_PREFIX}-${projectId}`;
}

/**
 * A named snapshot of the filter + sort state the user can re-apply in one
 * click (e.g. "My bugs", "Sprint 12", "Awaiting me"). Persisted per project.
 */
export interface SavedView {
	id: string;
	name: string;
	filters: KanbanFilters;
	sort: KanbanSort;
	/** Columns or list, the lanes and the list's sort; absent on a view saved before them. */
	layout?: BoardLayout;
	grouping?: LaneGrouping;
	listSort?: ListSort | null;
}

interface PersistedState {
	filters: KanbanFilters;
	sort: KanbanSort;
}

function isValidSavedView(v: unknown): v is SavedView {
	const candidate = v as Partial<SavedView> | null;
	return (
		!!candidate &&
		typeof candidate.id === "string" &&
		typeof candidate.name === "string" &&
		!!candidate.filters &&
		!!candidate.sort
	);
}

function loadViewsFromStorage(projectId: string): SavedView[] {
	try {
		const raw = localStorage.getItem(getViewsStorageKey(projectId));
		if (raw) {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				return parsed.filter(isValidSavedView);
			}
		}
	} catch {
		// Corrupt/missing cache — start with no saved views.
	}
	return [];
}

function saveViewsToStorage(
	projectId: string | null,
	views: SavedView[],
): void {
	if (!projectId) return;
	try {
		localStorage.setItem(getViewsStorageKey(projectId), JSON.stringify(views));
	} catch {
		// localStorage write failed — non-critical.
	}
}

/**
 * Mirror a partial board-state write to the main process, so filters/sort and
 * saved views survive across machines in server mode (localStorage is per-device).
 * Best-effort and guarded so it's a no-op when electronAPI is absent (tests).
 */
function saveBoardStateToMain(
	projectId: string | null,
	partial: { filters?: KanbanFilters; sort?: KanbanSort; savedViews?: SavedView[] },
): void {
	if (!projectId) return;
	try {
		globalThis.electronAPI?.saveKanbanBoardState(projectId, partial)?.catch(
			() => {
				// non-critical — localStorage cache still holds the state
			},
		);
	} catch {
		// electronAPI unavailable (e.g. tests) — ignore
	}
}

function loadFromStorage(projectId: string): PersistedState {
	try {
		const raw = localStorage.getItem(getStorageKey(projectId));
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<PersistedState>;
			return {
				filters: { ...EMPTY_FILTERS, ...parsed.filters },
				sort: { ...DEFAULT_SORT, ...parsed.sort },
			};
		}
	} catch {
		// Corrupt/missing cache — fall back to defaults.
	}
	return { filters: { ...EMPTY_FILTERS }, sort: { ...DEFAULT_SORT } };
}

function saveToStorage(
	projectId: string | null,
	filters: KanbanFilters,
	sort: KanbanSort,
): void {
	if (!projectId) return;
	try {
		localStorage.setItem(
			getStorageKey(projectId),
			JSON.stringify({ filters, sort }),
		);
	} catch {
		// localStorage write failed — non-critical, state still lives in memory.
	}
}

// ============================================
// Store
// ============================================

interface KanbanFilterState {
	/** Project the in-memory state currently belongs to. */
	projectId: string | null;
	filters: KanbanFilters;
	sort: KanbanSort;
	/** Named filter+sort presets for the active project. */
	savedViews: SavedView[];

	/** Load (or reset to) the persisted state for a project. */
	loadForProject: (projectId: string) => void;
	setSearch: (search: string) => void;
	toggleSource: (source: TaskSource) => void;
	toggleCategory: (category: TaskCategory) => void;
	togglePriority: (priority: TaskPriority) => void;
	/** Show only one split group, or everything again for the same group. */
	toggleGroup: (group: string) => void;
	/** Show one sprint's cards (or "none": the backlog), or every card with undefined. */
	setSprint: (sprint: string | undefined) => void;
	/** Add or remove a label from the filter (compared without case). */
	toggleLabel: (label: string) => void;
	toggleQuick: (quick: QuickFilter) => void;
	setSortField: (field: TaskSortField) => void;
	setSortDirection: (direction: TaskSortDirection) => void;
	toggleSortDirection: () => void;
	/** Clear filters only (keeps the chosen sort). */
	clearFilters: () => void;
	/** Snapshot the current filters+sort as a named, re-applicable view. */
	saveCurrentView: (name: string) => void;
	/** Re-apply a saved view's filters+sort. */
	applyView: (id: string) => void;
	/** Delete a saved view. */
	deleteView: (id: string) => void;
}

/** How the board is shown now, kept with a saved view. */
function viewLayout(): Pick<SavedView, "layout" | "grouping" | "listSort"> {
	const { layout, grouping, listSort } = useKanbanLanesStore.getState();
	return { layout, grouping, listSort: listSort ? { ...listSort } : null };
}

/** A copy of filters that later edits to the live ones leave alone. */
function copyFilters(filters: KanbanFilters): KanbanFilters {
	const copy: KanbanFilters = {
		...filters,
		sources: [...filters.sources],
		categories: [...filters.categories],
		priorities: [...filters.priorities],
	};
	if (filters.labels) copy.labels = [...filters.labels];
	if (filters.quick) copy.quick = [...filters.quick];
	return copy;
}

/** Toggle a value's presence in an array (immutably). */
function toggleInArray<T>(arr: T[], value: T): T[] {
	return arr.includes(value)
		? arr.filter((v) => v !== value)
		: [...arr, value];
}

export const useKanbanFilterStore = create<KanbanFilterState>((set, get) => {
	/** Persist whatever is currently in the store for the active project. */
	const persist = () => {
		const { projectId, filters, sort } = get();
		saveToStorage(projectId, filters, sort);
		saveBoardStateToMain(projectId, { filters, sort });
	};

	return {
		projectId: null,
		filters: { ...EMPTY_FILTERS },
		sort: { ...DEFAULT_SORT },
		savedViews: [],

		loadForProject: (projectId) => {
			if (get().projectId === projectId) return;
			const { filters, sort } = loadFromStorage(projectId);
			set({
				projectId,
				filters,
				sort,
				savedViews: loadViewsFromStorage(projectId),
			});

			// Async: pull the main-process copy (source of truth, shared across
			// machines in server mode) and override the local cache if present.
			(async () => {
				try {
					const result =
						await globalThis.electronAPI?.getKanbanBoardState(projectId);
					// Discard if the user switched projects while the IPC was in flight.
					if (get().projectId !== projectId || !result?.success || !result.data)
						return;
					const data = result.data;
					const patch: Partial<
						Pick<KanbanFilterState, "filters" | "sort" | "savedViews">
					> = {};
					if (data.filters && typeof data.filters === "object") {
						patch.filters = {
							...EMPTY_FILTERS,
							...(data.filters as Partial<KanbanFilters>),
						};
					}
					if (data.sort && typeof data.sort === "object") {
						patch.sort = {
							...DEFAULT_SORT,
							...(data.sort as Partial<KanbanSort>),
						};
					}
					if (Array.isArray(data.savedViews)) {
						patch.savedViews = data.savedViews.filter(isValidSavedView);
					}
					if (Object.keys(patch).length === 0) return;
					set(patch);
					// Refresh the localStorage caches with the source of truth.
					if (patch.filters || patch.sort) {
						const next = get();
						saveToStorage(projectId, next.filters, next.sort);
					}
					if (patch.savedViews) {
						saveViewsToStorage(projectId, patch.savedViews);
					}
				} catch {
					// IPC unavailable/failed — keep localStorage/defaults
				}
			})();
		},

		setSearch: (search) => {
			set((state) => ({ filters: { ...state.filters, search } }));
			persist();
		},

		toggleSource: (source) => {
			set((state) => ({
				filters: {
					...state.filters,
					sources: toggleInArray(state.filters.sources, source),
				},
			}));
			persist();
		},

		toggleCategory: (category) => {
			set((state) => ({
				filters: {
					...state.filters,
					categories: toggleInArray(state.filters.categories, category),
				},
			}));
			persist();
		},

		togglePriority: (priority) => {
			set((state) => ({
				filters: {
					...state.filters,
					priorities: toggleInArray(state.filters.priorities, priority),
				},
			}));
			persist();
		},

		toggleGroup: (group) => {
			set((state) => {
				const { group: current, ...rest } = state.filters;
				return { filters: current === group ? rest : { ...rest, group } };
			});
			persist();
		},

		setSprint: (sprint) => {
			set((state) => {
				const { sprint: _current, ...rest } = state.filters;
				return { filters: sprint ? { ...rest, sprint } : rest };
			});
			persist();
		},

		toggleLabel: (label) => {
			set((state) => {
				const current = state.filters.labels ?? [];
				const key = label.toLocaleLowerCase();
				const has = current.some((item) => item.toLocaleLowerCase() === key);
				const labels = has ? current.filter((item) => item.toLocaleLowerCase() !== key) : [...current, label];
				return { filters: { ...state.filters, labels } };
			});
			persist();
		},

		toggleQuick: (quick) => {
			set((state) => ({
				filters: { ...state.filters, quick: toggleInArray(state.filters.quick ?? [], quick) },
			}));
			persist();
		},

		setSortField: (field) => {
			set((state) => ({ sort: { ...state.sort, field } }));
			persist();
		},

		setSortDirection: (direction) => {
			set((state) => ({ sort: { ...state.sort, direction } }));
			persist();
		},

		toggleSortDirection: () => {
			set((state) => ({
				sort: {
					...state.sort,
					direction: state.sort.direction === "asc" ? "desc" : "asc",
				},
			}));
			persist();
		},

		clearFilters: () => {
			set({ filters: { ...EMPTY_FILTERS } });
			persist();
		},

		saveCurrentView: (name) => {
			const trimmed = name.trim();
			if (!trimmed) return;
			const { filters, sort, savedViews, projectId } = get();
			const view: SavedView = {
				id:
					globalThis.crypto?.randomUUID?.() ??
					`view-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				name: trimmed,
				filters: copyFilters(filters),
				sort: { ...sort },
				...viewLayout(),
			};
			const nextViews = [...savedViews, view];
			set({ savedViews: nextViews });
			saveViewsToStorage(projectId, nextViews);
			saveBoardStateToMain(projectId, { savedViews: nextViews });
		},

		applyView: (id) => {
			const view = get().savedViews.find((v) => v.id === id);
			if (!view) return;
			set({
				filters: copyFilters(view.filters),
				sort: { ...view.sort },
			});
			persist();
			useKanbanLanesStore.getState().applyView(view);
		},

		deleteView: (id) => {
			const { savedViews, projectId } = get();
			const nextViews = savedViews.filter((v) => v.id !== id);
			set({ savedViews: nextViews });
			saveViewsToStorage(projectId, nextViews);
			saveBoardStateToMain(projectId, { savedViews: nextViews });
		},
	};
});

/**
 * The board's filters with what « Mes tâches » needs: the server cards whose
 * claim is mine (the team room's locks, server mode). Same object while
 * nothing changes, so the board's memo holds.
 */
export function useBoardFilters(): KanbanFilters & BoardFilterContext {
	const filters = useKanbanFilterStore((s) => s.filters);
	const locks = useCollaborationStore((s) => s.locks);
	const me = useCollaborationStore((s) => s.me?.id);
	return useMemo(() => {
		if (!filters.quick?.includes("mine")) return filters;
		const mine = Object.values(locks).filter((lock) => lock.userId === me);
		return { ...filters, claimedByMe: new Set(mine.map((lock) => lock.taskId)) };
	}, [filters, locks, me]);
}
