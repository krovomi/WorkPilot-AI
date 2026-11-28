import { create } from "zustand";
import type { GitHubSyncStatus } from "../../../shared/types";

interface SyncStatusState {
	// Sync status
	syncStatus: GitHubSyncStatus | null;
	connectionError: string | null;

	// Actions
	setSyncStatus: (status: GitHubSyncStatus | null) => void;
	setConnectionError: (error: string | null) => void;
	clearSyncStatus: () => void;

	// Selectors
	isConnected: () => boolean;
	getRepoFullName: () => string | null;
}

export const useSyncStatusStore = create<SyncStatusState>((set, get) => ({
	// Initial state
	syncStatus: null,
	connectionError: null,

	// Actions
	setSyncStatus: (syncStatus) => set({ syncStatus, connectionError: null }),

	// A failed check forgets the last status: it may be another project's.
	setConnectionError: (connectionError) =>
		set({ syncStatus: null, connectionError }),

	clearSyncStatus: () =>
		set({
			syncStatus: null,
			connectionError: null,
		}),

	// Selectors
	isConnected: () => {
		const { syncStatus } = get();
		return syncStatus?.connected ?? false;
	},

	getRepoFullName: () => {
		const { syncStatus } = get();
		return syncStatus?.repoFullName ?? null;
	},
}));

/**
 * Check GitHub connection status
 */
/**
 * The latest check: switching projects starts a new one, and the previous
 * project's answer (its repository) must not land after it.
 */
let latestConnectionCheck = 0;
let latestCheckedProjectId: string | null = null;

export async function checkGitHubConnection(
	projectId: string,
): Promise<GitHubSyncStatus | null> {
	const store = useSyncStatusStore.getState();
	const check = ++latestConnectionCheck;
	// Another project: its status is unknown until GitHub answers, never the
	// previous project's repository.
	if (latestCheckedProjectId !== projectId) {
		latestCheckedProjectId = projectId;
		store.setSyncStatus(null);
	}

	try {
		const result = await window.electronAPI.checkGitHubConnection(projectId);
		if (check !== latestConnectionCheck) return null;
		if (result.success && result.data) {
			store.setSyncStatus(result.data);
			return result.data;
		} else {
			// No reason given: the view says what to do in the app's language.
			store.setConnectionError(result.error || null);
			return null;
		}
	} catch (error) {
		if (check !== latestConnectionCheck) return null;
		store.setConnectionError(error instanceof Error ? error.message : null);
		return null;
	}
}
