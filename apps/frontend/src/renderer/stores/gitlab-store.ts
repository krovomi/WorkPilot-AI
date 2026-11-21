import i18n from "i18next";
import { create } from "zustand";
import { useProjectStore } from "./project-store";
import { loadTasks } from "./task-store";
import type {
	GitLabInvestigationResult,
	GitLabInvestigationStatus,
	GitLabIssue,
	GitLabSyncStatus,
} from "../../shared/types";

interface GitLabState {
	// Data
	issues: GitLabIssue[];
	syncStatus: GitLabSyncStatus | null;

	// UI State
	isLoading: boolean;
	error: string | null;
	selectedIssueIid: number | null;
	filterState: "opened" | "closed" | "all";

	// Investigation state
	investigationStatus: GitLabInvestigationStatus;
	lastInvestigationResult: GitLabInvestigationResult | null;

	// Actions
	setIssues: (issues: GitLabIssue[]) => void;
	setSyncStatus: (status: GitLabSyncStatus | null) => void;
	setLoading: (loading: boolean) => void;
	setError: (error: string | null) => void;
	selectIssue: (issueIid: number | null) => void;
	setFilterState: (state: "opened" | "closed" | "all") => void;
	setInvestigationStatus: (status: GitLabInvestigationStatus) => void;
	setInvestigationResult: (result: GitLabInvestigationResult | null) => void;

	// Selectors
	getFilteredIssues: () => GitLabIssue[];
	getOpenIssuesCount: () => number;
}

export const useGitLabStore = create<GitLabState>((set, get) => ({
	// Initial state
	issues: [],
	syncStatus: null,
	isLoading: false,
	error: null,
	selectedIssueIid: null,
	filterState: "opened",
	investigationStatus: {
		phase: "idle",
		progress: 0,
		message: "",
	},
	lastInvestigationResult: null,

	// Actions
	setIssues: (issues) => set({ issues, error: null }),

	setSyncStatus: (syncStatus) => set({ syncStatus }),

	setLoading: (isLoading) => set({ isLoading }),

	setError: (error) => set({ error, isLoading: false }),

	selectIssue: (selectedIssueIid) => set({ selectedIssueIid }),

	setFilterState: (filterState) => set({ filterState }),

	setInvestigationStatus: (investigationStatus) => set({ investigationStatus }),

	setInvestigationResult: (lastInvestigationResult) =>
		set({ lastInvestigationResult }),

	// Selectors
	getFilteredIssues: () => {
		const { issues, filterState } = get();
		if (filterState === "all") return issues;
		return issues.filter((issue) => issue.state === filterState);
	},

	getOpenIssuesCount: () => {
		const { issues } = get();
		return issues.filter((issue) => issue.state === "opened").length;
	},
}));

/**
 * An answer counts only while its project is still the one on screen: a person
 * who left the project before the answer arrived would otherwise see the issues
 * or the connection of the project they left in the one they are looking at.
 */
const isShownProject = (projectId: string) =>
	useProjectStore.getState().selectedProjectId === projectId;

// Action functions for use outside of React components
export async function loadGitLabIssues(
	projectId: string,
	state?: "opened" | "closed" | "all",
): Promise<void> {
	const store = useGitLabStore.getState();
	// setError also clears the loading flag, so it goes first.
	store.setError(null);
	store.setLoading(true);

	// Sync filterState with the requested state
	if (state) {
		store.setFilterState(state);
	}

	try {
		const result = await window.electronAPI.getGitLabIssues(projectId, state);
		if (!isShownProject(projectId)) return;
		if (result.success && result.data) {
			store.setIssues(result.data);
		} else {
			store.setError(result.error || i18n.t("gitlab:errors.loadIssues"));
		}
	} catch (error) {
		if (!isShownProject(projectId)) return;
		store.setError(
			error instanceof Error ? error.message : i18n.t("gitlab:errors.unknown"),
		);
	}
	// A stale answer leaves the loading flag to the load of the project shown.
	store.setLoading(false);
}

export async function checkGitLabConnection(
	projectId: string,
): Promise<GitLabSyncStatus | null> {
	const store = useGitLabStore.getState();

	try {
		const result = await window.electronAPI.checkGitLabConnection(projectId);
		if (!isShownProject(projectId)) return null;
		if (result.success && result.data) {
			store.setSyncStatus(result.data);
			return result.data;
		}
		store.setError(result.error || i18n.t("gitlab:errors.checkConnection"));
		return null;
	} catch (error) {
		if (!isShownProject(projectId)) return null;
		store.setError(
			error instanceof Error ? error.message : i18n.t("gitlab:errors.unknown"),
		);
		return null;
	}
}

export function investigateGitLabIssue(
	projectId: string,
	issueIid: number,
	selectedNoteIds?: number[],
): void {
	const store = useGitLabStore.getState();
	store.setInvestigationStatus({
		phase: "fetching",
		issueIid,
		progress: 0,
		message: i18n.t("gitlab:investigation.phases.fetching"),
	});
	store.setInvestigationResult(null);

	window.electronAPI.investigateGitLabIssue(
		projectId,
		issueIid,
		selectedNoteIds,
	);
}

/**
 * Follow GitLab issue investigations for the life of the window (registered by
 * global-listeners.ts): the issues page unmounts when it is left, and an
 * investigation that ended meanwhile used to stay "investigating" forever.
 * Only the project on screen is followed, read when the event arrives.
 */
export function setupGitLabInvestigationListeners(): () => void {
	const store = () => useGitLabStore.getState();

	const cleanupProgress = window.electronAPI.onGitLabInvestigationProgress(
		(projectId, status) => {
			if (isShownProject(projectId)) store().setInvestigationStatus(status);
		},
	);
	const cleanupComplete = window.electronAPI.onGitLabInvestigationComplete(
		(projectId, result) => {
			if (!isShownProject(projectId)) return;
			store().setInvestigationResult(result);
			// The new task appears on the Kanban board.
			if (result.success && result.taskId) loadTasks(projectId);
		},
	);
	const cleanupError = window.electronAPI.onGitLabInvestigationError(
		(projectId, error) => {
			if (!isShownProject(projectId)) return;
			store().setError(error);
			store().setInvestigationStatus({
				phase: "error",
				progress: 0,
				message: error,
				error,
			});
		},
	);

	return () => {
		cleanupProgress();
		cleanupComplete();
		cleanupError();
	};
}
