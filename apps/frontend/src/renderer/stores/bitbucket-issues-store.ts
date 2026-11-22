/**
 * The Bitbucket issues view: the connection, the issues of the project on
 * screen, an issue's comments and the import as tasks. Each answer counts
 * only while its project is still the one on screen (`activeProjectId`, else
 * `selectedProjectId`, as App.tsx picks the view's project): one that arrives
 * after a project switch is dropped, and loading another project starts from
 * an empty view.
 */

import i18n from "i18next";
import { create } from "zustand";
import type {
	BitbucketComment,
	BitbucketImportResult,
	BitbucketIssue,
	BitbucketIssueFilter,
	BitbucketSyncStatus,
	IPCResult,
} from "../../shared/types";
import { useProjectStore } from "./project-store";
import { loadTasks } from "./task-store";

/** Whether `projectId` is the project the views show now. */
export function isShownProject(projectId: string): boolean {
	const { activeProjectId, selectedProjectId } = useProjectStore.getState();
	return (activeProjectId || selectedProjectId) === projectId;
}

/** A failed call's message, else the view's own. */
export function failure(result: IPCResult<unknown> | undefined, key: string): string {
	return result?.error || i18n.t(key);
}

interface BitbucketIssuesState {
	projectId: string | null;
	syncStatus: BitbucketSyncStatus | null;
	issues: BitbucketIssue[];
	issuesEnabled: boolean;
	filter: BitbucketIssueFilter;
	isLoading: boolean;
	error: string | null;
	selectedId: number | null;
	comments: Record<number, BitbucketComment[]>;
	checked: number[];
	isImporting: boolean;
	importResult: BitbucketImportResult | null;
	selectIssue: (id: number | null) => void;
	toggleChecked: (id: number) => void;
	setFilter: (filter: BitbucketIssueFilter) => void;
}

const EMPTY = {
	syncStatus: null,
	issues: [],
	issuesEnabled: true,
	isLoading: false,
	error: null,
	selectedId: null,
	comments: {},
	checked: [],
	isImporting: false,
	importResult: null,
};

export const useBitbucketIssuesStore = create<BitbucketIssuesState>((set) => ({
	projectId: null,
	filter: "open",
	...EMPTY,
	selectIssue: (selectedId) => set({ selectedId }),
	toggleChecked: (id) =>
		set((s) => ({
			checked: s.checked.includes(id) ? s.checked.filter((c) => c !== id) : [...s.checked, id],
		})),
	setFilter: (filter) => set({ filter }),
}));

const store = () => useBitbucketIssuesStore.getState();

/** Starts the view over for `projectId` when it shows another project's data. */
function forProject(projectId: string): void {
	if (store().projectId !== projectId) useBitbucketIssuesStore.setState({ projectId, ...EMPTY });
}

export async function checkBitbucketConnection(projectId: string): Promise<boolean> {
	forProject(projectId);
	const result = await window.electronAPI.bitbucket.checkConnection(projectId).catch(() => undefined);
	if (!isShownProject(projectId)) return false;
	if (result?.success && result.data) {
		useBitbucketIssuesStore.setState({ syncStatus: result.data });
		return result.data.connected;
	}
	useBitbucketIssuesStore.setState({
		syncStatus: { connected: false, error: failure(result, "bitbucket:errors.checkConnection") },
	});
	return false;
}

export async function loadBitbucketIssues(projectId: string, filter = store().filter): Promise<void> {
	forProject(projectId);
	useBitbucketIssuesStore.setState({ isLoading: true, error: null, filter });
	const result = await window.electronAPI.bitbucket.getIssues(projectId, filter).catch(() => undefined);
	if (!isShownProject(projectId) || store().filter !== filter) return;
	if (result?.success && result.data) {
		useBitbucketIssuesStore.setState({
			issues: result.data.issues,
			issuesEnabled: result.data.issuesEnabled,
			isLoading: false,
		});
	} else {
		useBitbucketIssuesStore.setState({ error: failure(result, "bitbucket:errors.loadIssues"), isLoading: false });
	}
}

export async function loadBitbucketIssueComments(projectId: string, id: number): Promise<void> {
	const result = await window.electronAPI.bitbucket.getIssueComments(projectId, id).catch(() => undefined);
	if (!isShownProject(projectId) || store().projectId !== projectId) return;
	if (result?.success && result.data) {
		const comments = result.data;
		useBitbucketIssuesStore.setState((s) => ({ comments: { ...s.comments, [id]: comments } }));
	}
}

/** Imports the checked issues (or `ids`) as tasks, then shows the new cards on the board. */
export async function importBitbucketIssues(projectId: string, ids = store().checked): Promise<void> {
	if (ids.length === 0) return;
	useBitbucketIssuesStore.setState({ isImporting: true, importResult: null });
	const result = await window.electronAPI.bitbucket.importIssues(projectId, ids).catch(() => undefined);
	if (!isShownProject(projectId) || store().projectId !== projectId) return;
	if (result?.success && result.data) {
		useBitbucketIssuesStore.setState({ isImporting: false, importResult: result.data, checked: [] });
		if (result.data.imported > 0) void loadTasks(projectId);
	} else {
		useBitbucketIssuesStore.setState({
			isImporting: false,
			importResult: {
				success: false,
				imported: 0,
				failed: ids.length,
				errors: [failure(result, "bitbucket:errors.import")],
			},
		});
	}
}
