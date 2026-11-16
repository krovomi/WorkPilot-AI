import { create } from "zustand";
import type {
	GitHubInvestigationResult,
	GitHubInvestigationStatus,
} from "../../../shared/types";
import { useProjectStore } from "../project-store";
import { loadTasks } from "../task-store";
import { useIssuesStore } from "./issues-store";

interface InvestigationState {
	// Investigation state
	investigationStatus: GitHubInvestigationStatus;
	lastInvestigationResult: GitHubInvestigationResult | null;

	// Actions
	setInvestigationStatus: (status: GitHubInvestigationStatus) => void;
	setInvestigationResult: (result: GitHubInvestigationResult | null) => void;
	clearInvestigation: () => void;
}

export const useInvestigationStore = create<InvestigationState>((set) => ({
	// Initial state
	investigationStatus: {
		phase: "idle",
		progress: 0,
		message: "",
	},
	lastInvestigationResult: null,

	// Actions
	setInvestigationStatus: (investigationStatus) => set({ investigationStatus }),

	setInvestigationResult: (lastInvestigationResult) =>
		set({ lastInvestigationResult }),

	clearInvestigation: () =>
		set({
			investigationStatus: { phase: "idle", progress: 0, message: "" },
			lastInvestigationResult: null,
		}),
}));

/**
 * Start investigating a GitHub issue
 */
export function investigateGitHubIssue(
	projectId: string,
	issueNumber: number,
	selectedCommentIds?: number[],
): void {
	const store = useInvestigationStore.getState();
	store.setInvestigationStatus({
		phase: "fetching",
		issueNumber,
		progress: 0,
		message: "Starting investigation...",
	});
	store.setInvestigationResult(null);

	window.electronAPI.investigateGitHubIssue(
		projectId,
		issueNumber,
		selectedCommentIds,
	);
}

/**
 * Follow GitHub issue investigations for the life of the window (registered by
 * global-listeners.ts): the issues page unmounts when it is left, and an
 * investigation that ended meanwhile used to stay "investigating" forever.
 * Only the project on screen is followed, read when the event arrives.
 */
export function setupGitHubInvestigationListeners(): () => void {
	const isShown = (projectId: string) =>
		useProjectStore.getState().selectedProjectId === projectId;
	const store = () => useInvestigationStore.getState();

	const cleanupProgress = window.electronAPI.onGitHubInvestigationProgress(
		(projectId, status) => {
			if (isShown(projectId)) store().setInvestigationStatus(status);
		},
	);
	const cleanupComplete = window.electronAPI.onGitHubInvestigationComplete(
		(projectId, result) => {
			if (!isShown(projectId)) return;
			store().setInvestigationResult(result);
			// The new task appears on the Kanban board.
			if (result.success && result.taskId) loadTasks(projectId);
		},
	);
	const cleanupError = window.electronAPI.onGitHubInvestigationError(
		(projectId, error) => {
			if (!isShown(projectId)) return;
			useIssuesStore.getState().setError(error);
			// `error` is what the dialog's red box shows.
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
