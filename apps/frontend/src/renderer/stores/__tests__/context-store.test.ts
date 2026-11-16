/**
 * The Context page's data: the project index, the memory, the recent memories
 * and the memory search, for the project on screen only, and for the query
 * now in the search box only.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadProjectContext,
	loadRecentMemories,
	refreshProjectIndex,
	searchMemories,
	useContextStore,
} from "../context-store";

let api: Record<string, ReturnType<typeof vi.fn>>;
const state = () => useContextStore.getState();
const context = (name: string) => ({
	projectIndex: { name },
	memoryStatus: { enabled: true },
	memoryState: { episodes: 1 },
	recentMemories: [{ id: `${name}-m` }],
});

function deferred() {
	let resolve: (value: unknown) => void = vi.fn();
	let reject: (reason: unknown) => void = vi.fn();
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(async () => {
	api = {
		getProjectContext: vi.fn(async (id: string) => ({ success: true, data: context(id) })),
		refreshProjectIndex: vi.fn(async (id: string) => ({ success: true, data: { name: `${id}-fresh` } })),
		searchMemories: vi.fn(async (_id: string, query: string) => ({ success: true, data: [{ content: query }] })),
		getRecentMemories: vi.fn(async (id: string) => ({ success: true, data: [{ id: `${id}-recent` }] })),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
	await loadProjectContext("p1");
});

describe("the project's context", () => {
	it("loads the index, the memory and the recent memories", () => {
		expect(api.getProjectContext).toHaveBeenCalledWith("p1");
		expect(state()).toMatchObject({
			projectIndex: { name: "p1" },
			memoryStatus: { enabled: true },
			memoryState: { episodes: 1 },
			recentMemories: [{ id: "p1-m" }],
			indexLoading: false,
			memoryLoading: false,
			indexError: null,
		});
	});

	it("has no recent memories when the answer lists none", async () => {
		api.getProjectContext.mockResolvedValueOnce({ success: true, data: { ...context("p1"), recentMemories: undefined } });
		await loadProjectContext("p1");
		expect(state().recentMemories).toEqual([]);
	});

	it("says why it could not be read", async () => {
		api.getProjectContext.mockResolvedValueOnce({ success: false, error: "no index" });
		await loadProjectContext("p1");
		expect(state()).toMatchObject({ indexError: "no index", indexLoading: false, memoryLoading: false });
		api.getProjectContext.mockResolvedValueOnce({ success: false });
		await loadProjectContext("p1");
		expect(state().indexError).toBe("Failed to load project context");
		api.getProjectContext.mockRejectedValueOnce(new Error("ipc closed"));
		await loadProjectContext("p1");
		expect(state().indexError).toBe("ipc closed");
		api.getProjectContext.mockRejectedValueOnce(0);
		await loadProjectContext("p1");
		expect(state().indexError).toBe("Unknown error");
	});

	it("keeps the project's data while it reloads, and drops the last project's at once", async () => {
		const reload = loadProjectContext("p1");
		expect(state()).toMatchObject({ projectIndex: { name: "p1" }, indexLoading: true });
		await reload;

		const other = loadProjectContext("p2");
		expect(state()).toMatchObject({ projectIndex: null, recentMemories: [], indexLoading: true });
		await other;
		expect(state().projectIndex).toEqual({ name: "p2" });
	});

	it("drops an answer, a failure or a refresh that arrives for the project left behind", async () => {
		const late = deferred();
		api.getProjectContext.mockReturnValueOnce(late.promise);
		const first = loadProjectContext("p1");
		await loadProjectContext("p2");
		late.resolve({ success: true, data: context("p1") });
		await first;
		expect(state()).toMatchObject({ projectIndex: { name: "p2" }, indexLoading: false });

		const failing = deferred();
		api.getProjectContext.mockReturnValueOnce(failing.promise);
		const second = loadProjectContext("p1");
		const third = loadProjectContext("p2");
		failing.reject(new Error("late"));
		await Promise.all([second, third]);
		expect(state().indexError).toBeNull();

		const refresh = deferred();
		api.refreshProjectIndex.mockReturnValueOnce(refresh.promise);
		await loadProjectContext("p1");
		const refreshing = refreshProjectIndex("p1");
		await loadProjectContext("p2");
		refresh.resolve({ success: true, data: { name: "p1-fresh" } });
		await refreshing;
		expect(state().projectIndex).toEqual({ name: "p2" });

		const refreshFailing = deferred();
		api.refreshProjectIndex.mockReturnValueOnce(refreshFailing.promise);
		await loadProjectContext("p1");
		const refreshingAgain = refreshProjectIndex("p1");
		const switching = loadProjectContext("p2");
		refreshFailing.reject(new Error("late"));
		await Promise.all([refreshingAgain, switching]);
		expect(state()).toMatchObject({ indexError: null, indexLoading: false });
	});
});

describe("refreshing the index", () => {
	it("re-runs the analyzer and shows the new index", async () => {
		await refreshProjectIndex("p1");
		expect(state()).toMatchObject({ projectIndex: { name: "p1-fresh" }, indexLoading: false });
	});

	it("says why it could not refresh, and keeps the index", async () => {
		api.refreshProjectIndex.mockResolvedValueOnce({ success: false, error: "analyzer crashed" });
		await refreshProjectIndex("p1");
		expect(state()).toMatchObject({ indexError: "analyzer crashed", projectIndex: { name: "p1" } });
		api.refreshProjectIndex.mockResolvedValueOnce({ success: false });
		await refreshProjectIndex("p1");
		expect(state().indexError).toBe("Failed to refresh project index");
		api.refreshProjectIndex.mockRejectedValueOnce(new Error("ipc closed"));
		await refreshProjectIndex("p1");
		expect(state().indexError).toBe("ipc closed");
		api.refreshProjectIndex.mockRejectedValueOnce(0);
		await refreshProjectIndex("p1");
		expect(state()).toMatchObject({ indexError: "Unknown error", indexLoading: false });
	});
});

describe("searching the memory", () => {
	it("shows the results of the query", async () => {
		await searchMemories("p1", "auth");
		expect(api.searchMemories).toHaveBeenCalledWith("p1", "auth");
		expect(state()).toMatchObject({ searchQuery: "auth", searchResults: [{ content: "auth" }], searchLoading: false });
	});

	it("clears the results for an empty query without asking", async () => {
		await searchMemories("p1", "auth");
		await searchMemories("p1", "  ");
		expect(state()).toMatchObject({ searchQuery: "  ", searchResults: [] });
		expect(api.searchMemories).toHaveBeenCalledOnce();
	});

	it("has no results when the search is refused or fails", async () => {
		api.searchMemories.mockResolvedValueOnce({ success: false });
		await searchMemories("p1", "a");
		expect(state().searchResults).toEqual([]);
		await searchMemories("p1", "b");
		api.searchMemories.mockRejectedValueOnce(new Error("x"));
		await searchMemories("p1", "c");
		expect(state()).toMatchObject({ searchResults: [], searchLoading: false });
	});

	it("keeps the answer to the last keystroke when an earlier one comes back later", async () => {
		const slow = deferred();
		api.searchMemories.mockReturnValueOnce(slow.promise);
		const early = searchMemories("p1", "au");
		await searchMemories("p1", "auth");
		slow.resolve({ success: true, data: [{ content: "au" }] });
		await early;
		expect(state()).toMatchObject({ searchQuery: "auth", searchResults: [{ content: "auth" }], searchLoading: false });

		const failing = deferred();
		api.searchMemories.mockReturnValueOnce(failing.promise);
		const stale = searchMemories("p1", "x");
		const pending = deferred();
		api.searchMemories.mockReturnValueOnce(pending.promise);
		const last = searchMemories("p1", "xy");
		failing.reject(new Error("late"));
		await stale;
		expect(state()).toMatchObject({ searchResults: [{ content: "auth" }], searchLoading: true });
		pending.resolve({ success: true, data: [] });
		await last;
		expect(state().searchLoading).toBe(false);
	});
});

describe("recent memories", () => {
	it("loads them for the project on screen", async () => {
		await loadRecentMemories("p1", 5);
		expect(api.getRecentMemories).toHaveBeenCalledWith("p1", 5);
		expect(state()).toMatchObject({ recentMemories: [{ id: "p1-recent" }], memoriesLoading: false });
		await loadRecentMemories("p1");
		expect(api.getRecentMemories).toHaveBeenLastCalledWith("p1", 20);
	});

	it("keeps them when the read is refused or fails", async () => {
		api.getRecentMemories.mockResolvedValueOnce({ success: false });
		await loadRecentMemories("p1");
		api.getRecentMemories.mockRejectedValueOnce(new Error("x"));
		await loadRecentMemories("p1");
		expect(state()).toMatchObject({ recentMemories: [{ id: "p1-m" }], memoriesLoading: false });
	});

	it("drops the memories of a project no longer on screen", async () => {
		useContextStore.setState({ memoriesLoading: true });
		await loadRecentMemories("p2");
		expect(state()).toMatchObject({ recentMemories: [{ id: "p1-m" }], memoriesLoading: true });
	});
});

describe("clearing", () => {
	it("empties everything", async () => {
		await searchMemories("p1", "auth");
		state().clearAll();
		expect(state()).toMatchObject({ projectIndex: null, memoryStatus: null, recentMemories: [], searchResults: [], searchQuery: "" });
	});
});
