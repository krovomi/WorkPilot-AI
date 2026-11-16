import { create } from "zustand";
import type {
	ContextSearchResult,
	MemoryState,
	MemoryStatus,
	MemoryEpisode,
	ProjectIndex,
} from "../../shared/types";

interface ContextState {
	// Project Index
	projectIndex: ProjectIndex | null;
	indexLoading: boolean;
	indexError: string | null;

	// Memory Status
	memoryStatus: MemoryStatus | null;
	memoryState: MemoryState | null;
	memoryLoading: boolean;
	memoryError: string | null;

	// Recent Memories
	recentMemories: MemoryEpisode[];
	memoriesLoading: boolean;

	// Search
	searchResults: ContextSearchResult[];
	searchLoading: boolean;
	searchQuery: string;

	// Actions
	setProjectIndex: (index: ProjectIndex | null) => void;
	setIndexLoading: (loading: boolean) => void;
	setIndexError: (error: string | null) => void;
	setMemoryStatus: (status: MemoryStatus | null) => void;
	setMemoryState: (state: MemoryState | null) => void;
	setMemoryLoading: (loading: boolean) => void;
	setMemoryError: (error: string | null) => void;
	setRecentMemories: (memories: MemoryEpisode[]) => void;
	setMemoriesLoading: (loading: boolean) => void;
	setSearchResults: (results: ContextSearchResult[]) => void;
	setSearchLoading: (loading: boolean) => void;
	setSearchQuery: (query: string) => void;
	clearAll: () => void;
}

export const useContextStore = create<ContextState>((set) => ({
	// Project Index
	projectIndex: null,
	indexLoading: false,
	indexError: null,

	// Memory Status
	memoryStatus: null,
	memoryState: null,
	memoryLoading: false,
	memoryError: null,

	// Recent Memories
	recentMemories: [],
	memoriesLoading: false,

	// Search
	searchResults: [],
	searchLoading: false,
	searchQuery: "",

	// Actions
	setProjectIndex: (index) => set({ projectIndex: index }),
	setIndexLoading: (loading) => set({ indexLoading: loading }),
	setIndexError: (error) => set({ indexError: error }),
	setMemoryStatus: (status) => set({ memoryStatus: status }),
	setMemoryState: (state) => set({ memoryState: state }),
	setMemoryLoading: (loading) => set({ memoryLoading: loading }),
	setMemoryError: (error) => set({ memoryError: error }),
	setRecentMemories: (memories) => set({ recentMemories: memories }),
	setMemoriesLoading: (loading) => set({ memoriesLoading: loading }),
	setSearchResults: (results) => set({ searchResults: results }),
	setSearchLoading: (loading) => set({ searchLoading: loading }),
	setSearchQuery: (query) => set({ searchQuery: query }),
	clearAll: () =>
		set({
			projectIndex: null,
			indexLoading: false,
			indexError: null,
			memoryStatus: null,
			memoryState: null,
			memoryLoading: false,
			memoryError: null,
			recentMemories: [],
			memoriesLoading: false,
			searchResults: [],
			searchLoading: false,
			searchQuery: "",
		}),
}));

/**
 * The project whose context the store holds. Every answer is checked against
 * it on arrival: one that comes back after the person moved to another project
 * belongs to a page nobody is looking at.
 */
let shownProject: string | null = null;
const isShown = (projectId: string) => projectId === shownProject;

/**
 * Load project context (project index + memory status)
 */
export async function loadProjectContext(projectId: string): Promise<void> {
	const store = useContextStore.getState();
	// Another project: its index, memories and search are not this one's.
	if (!isShown(projectId)) store.clearAll();
	shownProject = projectId;
	store.setIndexLoading(true);
	store.setMemoryLoading(true);
	store.setIndexError(null);
	store.setMemoryError(null);

	try {
		const result = await window.electronAPI.getProjectContext(projectId);
		if (!isShown(projectId)) return;
		if (result.success && result.data) {
			store.setProjectIndex(result.data.projectIndex);
			store.setMemoryStatus(result.data.memoryStatus);
			store.setMemoryState(result.data.memoryState);
			store.setRecentMemories(result.data.recentMemories || []);
		} else {
			store.setIndexError(result.error || "Failed to load project context");
		}
	} catch (error) {
		if (!isShown(projectId)) return;
		store.setIndexError(
			error instanceof Error ? error.message : "Unknown error",
		);
	} finally {
		if (isShown(projectId)) {
			store.setIndexLoading(false);
			store.setMemoryLoading(false);
		}
	}
}

/**
 * Refresh project index by re-running analyzer
 */
export async function refreshProjectIndex(projectId: string): Promise<void> {
	const store = useContextStore.getState();
	store.setIndexLoading(true);
	store.setIndexError(null);

	try {
		const result = await window.electronAPI.refreshProjectIndex(projectId);
		if (!isShown(projectId)) return;
		if (result.success && result.data) {
			store.setProjectIndex(result.data);
		} else {
			store.setIndexError(result.error || "Failed to refresh project index");
		}
	} catch (error) {
		if (!isShown(projectId)) return;
		store.setIndexError(
			error instanceof Error ? error.message : "Unknown error",
		);
	} finally {
		if (isShown(projectId)) store.setIndexLoading(false);
	}
}

/**
 * Search memories using semantic search
 */
export async function searchMemories(
	projectId: string,
	query: string,
): Promise<void> {
	const store = useContextStore.getState();
	store.setSearchQuery(query);

	if (!query.trim()) {
		store.setSearchResults([]);
		return;
	}

	store.setSearchLoading(true);
	// Only the answer to the query now in the box, for the project on screen,
	// is shown: answers to earlier keystrokes can come back after it.
	const current = () =>
		isShown(projectId) && useContextStore.getState().searchQuery === query;

	try {
		const result = await window.electronAPI.searchMemories(projectId, query);
		if (!current()) return;
		store.setSearchResults(result.success && result.data ? result.data : []);
	} catch (_error) {
		if (current()) store.setSearchResults([]);
	} finally {
		if (current()) store.setSearchLoading(false);
	}
}

/**
 * Load recent memories
 */
export async function loadRecentMemories(
	projectId: string,
	limit: number = 20,
): Promise<void> {
	const store = useContextStore.getState();
	store.setMemoriesLoading(true);

	try {
		const result = await window.electronAPI.getRecentMemories(projectId, limit);
		if (result.success && result.data && isShown(projectId)) {
			store.setRecentMemories(result.data);
		}
	} catch (_error) {
		// Silently fail - memories are optional
	} finally {
		if (isShown(projectId)) store.setMemoriesLoading(false);
	}
}
