/**
 * @vitest-environment jsdom
 */
/**
 * The lane preferences: per project, read back safely whatever storage
 * holds, and the sub-projects added by hand.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_LANE_PREFERENCES,
	MAX_EXTRA_AREAS,
	readLanePreferences,
	useKanbanLanesStore,
} from "../kanban-lanes-store";

beforeEach(() => {
	localStorage.clear();
	useKanbanLanesStore.setState({ ...DEFAULT_LANE_PREFERENCES, projectId: null });
});

describe("readLanePreferences", () => {
	it("falls back to the defaults on anything else than stored preferences", () => {
		expect(readLanePreferences(null)).toEqual(DEFAULT_LANE_PREFERENCES);
		expect(readLanePreferences("priority")).toEqual(DEFAULT_LANE_PREFERENCES);
		expect(readLanePreferences({ grouping: "assignee", pinFlagged: "yes" })).toEqual(DEFAULT_LANE_PREFERENCES);
	});

	it("keeps valid fields and drops the rest", () => {
		const read = readLanePreferences({
			grouping: "area",
			pinFlagged: false,
			collapsed: { area: ["api", 3], nonsense: ["x"] },
			areas: ["api", " api ", "bad\nname", 12, "web"],
		});
		expect(read).toEqual({ grouping: "area", pinFlagged: false, collapsed: { area: ["api"] }, areas: ["api", "web"], layout: "board", listSort: null });
	});
});

describe("useKanbanLanesStore", () => {
	it("keeps each project's choice apart", () => {
		const store = useKanbanLanesStore.getState();
		store.loadForProject("p1");
		useKanbanLanesStore.getState().setGrouping("priority");
		useKanbanLanesStore.getState().toggleCollapsed("low");
		useKanbanLanesStore.getState().loadForProject("p2");
		expect(useKanbanLanesStore.getState().grouping).toBe("none");
		useKanbanLanesStore.getState().loadForProject("p1");
		expect(useKanbanLanesStore.getState().grouping).toBe("priority");
		expect(useKanbanLanesStore.getState().collapsed.priority).toEqual(["low"]);
		useKanbanLanesStore.getState().toggleCollapsed("low");
		expect(useKanbanLanesStore.getState().collapsed.priority).toEqual([]);
	});

	it("survives a storage that refuses to be read", () => {
		localStorage.setItem("kanban-lanes-p3", "{not json");
		useKanbanLanesStore.getState().loadForProject("p3");
		expect(useKanbanLanesStore.getState().grouping).toBe("none");
	});

	it("adds a sub-project once, and refuses a name that is not one", () => {
		useKanbanLanesStore.getState().loadForProject("p1");
		const { addArea } = useKanbanLanesStore.getState();
		expect(addArea("  mobile ")).toBe(true);
		expect(addArea("mobile")).toBe(false);
		expect(addArea("   ")).toBe(false);
		expect(useKanbanLanesStore.getState().areas).toEqual(["mobile"]);
		for (let i = 1; i < MAX_EXTRA_AREAS; i++) addArea(`area ${i}`);
		expect(addArea("one too many")).toBe(false);
		expect(useKanbanLanesStore.getState().areas).toHaveLength(MAX_EXTRA_AREAS);
	});

	it("flips the pinned lane of blocked cards", () => {
		useKanbanLanesStore.getState().togglePinFlagged();
		expect(useKanbanLanesStore.getState().pinFlagged).toBe(false);
	});

	it("keeps the layout and the list's sort, and reads back only valid ones", () => {
		useKanbanLanesStore.getState().loadForProject("p");
		useKanbanLanesStore.getState().setLayout("list");
		useKanbanLanesStore.getState().setListSort({ field: "points", direction: "desc" });
		expect(JSON.parse(localStorage.getItem("kanban-lanes-p") ?? "{}")).toMatchObject({
			layout: "list",
			listSort: { field: "points", direction: "desc" },
		});
		expect(readLanePreferences({ layout: "timeline", listSort: { field: "x" } })).toMatchObject({
			layout: "board",
			listSort: null,
		});
	});

	it("brings back what a saved view holds, and leaves alone what it does not", () => {
		const lanes = () => useKanbanLanesStore.getState();
		lanes().loadForProject("p");
		lanes().applyView({ layout: "list", grouping: "sprint", listSort: { field: "title", direction: "asc" } });
		expect(lanes()).toMatchObject({ layout: "list", grouping: "sprint", listSort: { field: "title", direction: "asc" } });
		lanes().applyView({});
		expect(lanes()).toMatchObject({ layout: "list", grouping: "sprint", listSort: { field: "title", direction: "asc" } });
		lanes().applyView({ layout: "wall", grouping: "assignee", listSort: null });
		expect(lanes()).toMatchObject({ layout: "board", grouping: "none", listSort: null });
	});
});
