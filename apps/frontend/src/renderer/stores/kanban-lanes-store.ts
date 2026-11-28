/**
 * How a person cuts the Kanban into lanes, per project: the grouping, the
 * pinned « Bloquées » lane, the lanes they folded and the sub-projects they
 * added by hand. A per-viewer preference (like column widths), kept in
 * localStorage; the cards' fields themselves live with the cards.
 *
 * Design: docs/architecture/kanban-swimlanes.md.
 */
import { create } from "zustand";
import { cleanArea, LANE_GROUPINGS, type LaneGrouping } from "../lib/kanban-lanes";
import { BOARD_LAYOUTS, type BoardLayout, type ListSort, readListSort } from "../lib/kanban-list";

const KEY_PREFIX = "kanban-lanes";
/** Sub-projects added by hand, at most. */
export const MAX_EXTRA_AREAS = 50;

export interface LanePreferences {
	grouping: LaneGrouping;
	pinFlagged: boolean;
	/** Folded lanes, by grouping then lane key. */
	collapsed: Partial<Record<LaneGrouping, string[]>>;
	/** Sub-projects added by hand (an empty lane to drag cards into). */
	areas: string[];
	/** Columns, or a list of the cards (`lib/kanban-list.ts`). */
	layout: BoardLayout;
	/** The list's sort; null keeps the board's order. */
	listSort: ListSort | null;
}

export const DEFAULT_LANE_PREFERENCES: LanePreferences = {
	grouping: "none",
	pinFlagged: true,
	collapsed: {},
	areas: [],
	layout: "board",
	listSort: null,
};

function strings(value: unknown, limit: number): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.length <= 200).slice(0, limit);
}

/** Preferences read back from storage, whatever was stored there. */
export function readLanePreferences(raw: unknown): LanePreferences {
	const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const grouping = LANE_GROUPINGS.includes(value.grouping as LaneGrouping)
		? (value.grouping as LaneGrouping)
		: DEFAULT_LANE_PREFERENCES.grouping;
	const collapsed: LanePreferences["collapsed"] = {};
	const storedCollapsed = (value.collapsed && typeof value.collapsed === "object" ? value.collapsed : {}) as Record<
		string,
		unknown
	>;
	for (const key of LANE_GROUPINGS) {
		const lanes = strings(storedCollapsed[key], 200);
		if (lanes.length > 0) collapsed[key] = lanes;
	}
	const areas = [
		...new Set(strings(value.areas, MAX_EXTRA_AREAS).map(cleanArea).filter((area): area is string => !!area)),
	];
	return {
		grouping,
		pinFlagged: typeof value.pinFlagged === "boolean" ? value.pinFlagged : DEFAULT_LANE_PREFERENCES.pinFlagged,
		collapsed,
		areas,
		layout: BOARD_LAYOUTS.includes(value.layout as BoardLayout)
			? (value.layout as BoardLayout)
			: DEFAULT_LANE_PREFERENCES.layout,
		listSort: readListSort(value.listSort),
	};
}

function load(projectId: string): LanePreferences {
	try {
		const raw = localStorage.getItem(`${KEY_PREFIX}-${projectId}`);
		return raw ? readLanePreferences(JSON.parse(raw)) : { ...DEFAULT_LANE_PREFERENCES };
	} catch {
		return { ...DEFAULT_LANE_PREFERENCES };
	}
}

function save(projectId: string | null, preferences: LanePreferences): void {
	if (!projectId) return;
	try {
		localStorage.setItem(`${KEY_PREFIX}-${projectId}`, JSON.stringify(preferences));
	} catch {
		// Storage unavailable: the choice lasts until the app closes.
	}
}

interface KanbanLanesState extends LanePreferences {
	projectId: string | null;
	loadForProject: (projectId: string | null) => void;
	setGrouping: (grouping: LaneGrouping) => void;
	togglePinFlagged: () => void;
	toggleCollapsed: (laneKey: string) => void;
	/** Adds a sub-project lane; false when the name is not one or is already there. */
	addArea: (name: string) => boolean;
	setLayout: (layout: BoardLayout) => void;
	setListSort: (sort: ListSort | null) => void;
	/** What a saved view brings back, each part checked as if read from storage. */
	applyView: (view: { layout?: unknown; grouping?: unknown; listSort?: unknown }) => void;
}

function preferencesOf(state: LanePreferences): LanePreferences {
	return {
		grouping: state.grouping,
		pinFlagged: state.pinFlagged,
		collapsed: state.collapsed,
		areas: state.areas,
		layout: state.layout,
		listSort: state.listSort,
	};
}

export const useKanbanLanesStore = create<KanbanLanesState>((set, get) => {
	const update = (patch: Partial<LanePreferences>) => {
		set(patch);
		const state = get();
		save(state.projectId, preferencesOf(state));
	};
	return {
		...DEFAULT_LANE_PREFERENCES,
		projectId: null,
		loadForProject: (projectId) => {
			if (get().projectId === projectId) return;
			set({ projectId, ...(projectId ? load(projectId) : DEFAULT_LANE_PREFERENCES) });
		},
		setGrouping: (grouping) => update({ grouping }),
		togglePinFlagged: () => update({ pinFlagged: !get().pinFlagged }),
		toggleCollapsed: (laneKey) => {
			const { grouping, collapsed } = get();
			const folded = collapsed[grouping] ?? [];
			const next = folded.includes(laneKey) ? folded.filter((key) => key !== laneKey) : [...folded, laneKey];
			update({ collapsed: { ...collapsed, [grouping]: next } });
		},
		addArea: (name) => {
			const area = cleanArea(name);
			const { areas } = get();
			if (!area || areas.includes(area) || areas.length >= MAX_EXTRA_AREAS) return false;
			update({ areas: [...areas, area] });
			return true;
		},
		setLayout: (layout) => update({ layout }),
		setListSort: (listSort) => update({ listSort }),
		applyView: (view) => {
			const read = readLanePreferences(view);
			// A view saved before layouts existed brings back its filters only.
			const patch: Partial<LanePreferences> = {};
			if (view.layout !== undefined) patch.layout = read.layout;
			if (view.listSort !== undefined) patch.listSort = read.listSort;
			if (view.grouping !== undefined) patch.grouping = read.grouping;
			update(patch);
		},
	};
});
