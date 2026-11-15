/**
 * The Kanban filter store: the filters, sort and saved views of each project,
 * cached in localStorage, mirrored to the main process (shared across
 * machines in server mode), and the main copy winning when it answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SORT, EMPTY_FILTERS } from "../../lib/kanban-filter";
import { type SavedView, useKanbanFilterStore } from "../kanban-filter-store";

const api = { getKanbanBoardState: vi.fn(), saveKanbanBoardState: vi.fn() };
const INITIAL = useKanbanFilterStore.getState();
const store = () => useKanbanFilterStore.getState();
const cached = (key: string) => JSON.parse(localStorage.getItem(key) ?? "null");

function view(id: string, over: Partial<SavedView> = {}): SavedView {
	return { id, name: id, filters: { ...EMPTY_FILTERS }, sort: { ...DEFAULT_SORT }, ...over };
}

/** Opens a project whose main copy answers `data` (or nothing). */
async function open(projectId: string, data?: unknown) {
	api.getKanbanBoardState.mockResolvedValueOnce(
		data === undefined ? { success: false } : { success: true, data },
	);
	store().loadForProject(projectId);
	await vi.waitFor(() => expect(api.getKanbanBoardState).toHaveBeenCalledWith(projectId));
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(() => {
	useKanbanFilterStore.setState(INITIAL, true);
	localStorage.clear();
	api.getKanbanBoardState.mockReset();
	api.saveKanbanBoardState.mockReset().mockResolvedValue({ success: true });
	(globalThis as unknown as { electronAPI: typeof api }).electronAPI = api;
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("loading a project", () => {
	it("starts from defaults for a project never filtered", async () => {
		await open("p1");
		expect(store()).toMatchObject({
			projectId: "p1",
			filters: EMPTY_FILTERS,
			sort: DEFAULT_SORT,
			savedViews: [],
		});
	});

	it("reads the cached filters and views, dropping invalid views", async () => {
		localStorage.setItem(
			"kanban-filters-p1",
			JSON.stringify({ filters: { search: "bug" }, sort: { field: "title" } }),
		);
		localStorage.setItem(
			"kanban-views-p1",
			JSON.stringify([view("v1"), { id: "broken" }, null, { id: 1, name: "x", filters: {}, sort: {} }]),
		);
		await open("p1");
		expect(store().filters).toEqual({ ...EMPTY_FILTERS, search: "bug" });
		expect(store().sort).toEqual({ field: "title", direction: "desc" });
		expect(store().savedViews).toEqual([view("v1")]);
	});

	it("falls back to defaults when the cache is corrupt", async () => {
		localStorage.setItem("kanban-filters-p1", "{not json");
		localStorage.setItem("kanban-views-p1", "{not json");
		await open("p1");
		expect(store()).toMatchObject({ filters: EMPTY_FILTERS, savedViews: [] });
	});

	it("ignores cached views that are not a list", async () => {
		localStorage.setItem("kanban-views-p1", JSON.stringify({ id: "v" }));
		await open("p1");
		expect(store().savedViews).toEqual([]);
	});

	it("does nothing when the project is already loaded", async () => {
		await open("p1");
		store().loadForProject("p1");
		expect(api.getKanbanBoardState).toHaveBeenCalledOnce();
	});

	it("lets the main copy win and refreshes the cache with it", async () => {
		localStorage.setItem("kanban-filters-p1", JSON.stringify({ filters: { search: "local" } }));
		await open("p1", {
			filters: { search: "shared", sources: ["jira"] },
			sort: { direction: "asc" },
			savedViews: [view("v1"), { nope: true }],
		});
		await vi.waitFor(() => expect(store().filters.search).toBe("shared"));
		expect(store().filters.sources).toEqual(["jira"]);
		expect(store().sort).toEqual({ field: "manual", direction: "asc" });
		expect(store().savedViews).toEqual([view("v1")]);
		expect(cached("kanban-filters-p1").filters.search).toBe("shared");
		expect(cached("kanban-views-p1")).toEqual([view("v1")]);
	});

	it("takes only the parts the main copy has", async () => {
		await open("p1", { savedViews: [view("v1")] });
		await vi.waitFor(() => expect(store().savedViews).toEqual([view("v1")]));
		expect(localStorage.getItem("kanban-filters-p1")).toBeNull();

		await open("p2", { sort: { field: "priority" } });
		await vi.waitFor(() => expect(store().sort.field).toBe("priority"));
		expect(localStorage.getItem("kanban-views-p2")).toBeNull();
	});

	it("keeps the cache when the main copy is empty or malformed", async () => {
		localStorage.setItem("kanban-filters-p1", JSON.stringify({ filters: { search: "local" } }));
		await open("p1", { filters: "x", sort: 3, savedViews: "y" });
		expect(store().filters.search).toBe("local");

		await open("p2", null);
		expect(store().filters).toEqual(EMPTY_FILTERS);
	});

	it("discards the main copy of a project the user already left", async () => {
		let answer: (v: unknown) => void = () => undefined;
		api.getKanbanBoardState.mockReturnValueOnce(new Promise((r) => (answer = r)));
		store().loadForProject("p1");
		await open("p2");
		answer({ success: true, data: { filters: { search: "p1 filters" } } });
		await Promise.resolve();
		await Promise.resolve();
		expect(store()).toMatchObject({ projectId: "p2", filters: EMPTY_FILTERS });
	});

	it("keeps the cache when the main process cannot be reached", async () => {
		api.getKanbanBoardState.mockRejectedValueOnce(new Error("down"));
		store().loadForProject("p1");
		await vi.waitFor(() => expect(api.getKanbanBoardState).toHaveBeenCalled());
		expect(store().projectId).toBe("p1");
	});
});

describe("filters and sort", () => {
	beforeEach(() => open("p1"));

	it("stores each change in the cache and mirrors it to the main process", () => {
		store().setSearch("login");
		expect(store().filters.search).toBe("login");
		expect(cached("kanban-filters-p1").filters.search).toBe("login");
		expect(api.saveKanbanBoardState).toHaveBeenLastCalledWith("p1", {
			filters: expect.objectContaining({ search: "login" }),
			sort: DEFAULT_SORT,
		});
	});

	it("toggles sources, categories and priorities on and off", () => {
		store().toggleSource("jira");
		store().toggleCategory("bug_fix");
		store().togglePriority("high");
		expect(store().filters).toMatchObject({
			sources: ["jira"],
			categories: ["bug_fix"],
			priorities: ["high"],
		});
		store().toggleSource("jira");
		store().toggleCategory("bug_fix");
		store().togglePriority("high");
		expect(store().filters).toEqual(EMPTY_FILTERS);
	});

	it("shows one split group, then everything again", () => {
		store().toggleGroup("001-split");
		expect(store().filters.group).toBe("001-split");
		store().toggleGroup("002-split");
		expect(store().filters.group).toBe("002-split");
		store().toggleGroup("002-split");
		expect(store().filters).not.toHaveProperty("group");
	});

	it("sets and flips the sort", () => {
		store().setSortField("updated");
		store().setSortDirection("asc");
		expect(store().sort).toEqual({ field: "updated", direction: "asc" });
		store().toggleSortDirection();
		expect(store().sort.direction).toBe("desc");
		store().toggleSortDirection();
		expect(store().sort.direction).toBe("asc");
	});

	it("clears the filters but keeps the sort", () => {
		store().setSearch("x");
		store().setSortField("title");
		store().clearFilters();
		expect(store().filters).toEqual(EMPTY_FILTERS);
		expect(store().sort.field).toBe("title");
	});

	it("keeps working in memory when the cache or the main process refuses", () => {
		vi.spyOn(localStorage, "setItem").mockImplementation(() => {
			throw new Error("quota");
		});
		api.saveKanbanBoardState.mockRejectedValue(new Error("down"));
		store().setSearch("x");
		store().saveCurrentView("v");
		expect(store().filters.search).toBe("x");
		expect(store().savedViews).toHaveLength(1);

		api.saveKanbanBoardState.mockImplementation(() => {
			throw new Error("no bridge");
		});
		store().setSearch("y");
		expect(store().filters.search).toBe("y");
	});
});

describe("saved views", () => {
	beforeEach(() => open("p1"));

	it("saves the current filters and sort under a trimmed name", () => {
		store().toggleSource("github");
		store().setSortField("priority");
		store().saveCurrentView("  My bugs ");
		const [saved] = store().savedViews;
		expect(saved).toMatchObject({
			name: "My bugs",
			filters: { sources: ["github"] },
			sort: { field: "priority" },
		});
		expect(typeof saved.id).toBe("string");
		expect(cached("kanban-views-p1")).toEqual([saved]);
		expect(api.saveKanbanBoardState).toHaveBeenLastCalledWith("p1", { savedViews: [saved] });
	});

	it("copies the filters, so later changes do not alter the view", () => {
		store().toggleSource("github");
		store().saveCurrentView("v");
		store().toggleSource("jira");
		expect(store().savedViews[0].filters.sources).toEqual(["github"]);
	});

	it("names a view without crypto.randomUUID too", () => {
		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(undefined as never);
		store().saveCurrentView("v");
		expect(store().savedViews[0].id).toMatch(/^view-\d+-/);
	});

	it("refuses a view without a name", () => {
		store().saveCurrentView("   ");
		expect(store().savedViews).toEqual([]);
	});

	it("applies a view, as a copy, and ignores an unknown one", () => {
		const saved = view("v1", {
			filters: { ...EMPTY_FILTERS, sources: ["jira"] },
			sort: { field: "title", direction: "asc" },
		});
		useKanbanFilterStore.setState({ savedViews: [saved] });
		store().applyView("v1");
		expect(store().filters.sources).toEqual(["jira"]);
		expect(store().sort).toEqual({ field: "title", direction: "asc" });
		store().toggleSource("github");
		expect(saved.filters.sources).toEqual(["jira"]);

		store().applyView("missing");
		expect(store().filters.sources).toEqual(["jira", "github"]);
	});

	it("deletes a view everywhere", () => {
		useKanbanFilterStore.setState({ savedViews: [view("v1"), view("v2")] });
		store().deleteView("v1");
		expect(store().savedViews).toEqual([view("v2")]);
		expect(cached("kanban-views-p1")).toEqual([view("v2")]);
		expect(api.saveKanbanBoardState).toHaveBeenLastCalledWith("p1", { savedViews: [view("v2")] });
	});
});

it("persists nothing before a project is loaded", () => {
	store().setSearch("x");
	store().saveCurrentView("v");
	expect(api.saveKanbanBoardState).not.toHaveBeenCalled();
	expect(localStorage.getItem("kanban-filters-null")).toBeNull();
});
