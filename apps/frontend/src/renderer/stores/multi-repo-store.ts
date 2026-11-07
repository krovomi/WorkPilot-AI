/**
 * Multi-repo orchestrations of the selected project, as the dialog shows them.
 *
 * The main process runs them (`main/multi-repo/`) and sends the whole
 * orchestration on each change (`onMultiRepoUpdated`); this store keeps the
 * latest of each and the dialog's form.
 */
import type { MultiRepoOrchestration } from "@shared/types";
import { create } from "zustand";
import { loadProjects } from "./project-store";

export type MultiRepoView = "list" | "new" | "detail";

/** A repository picked in the form: a project of this computer or a folder. */
export interface PickedRepo {
	readonly path: string;
	readonly name: string;
}

interface MultiRepoState {
	isDialogOpen: boolean;
	view: MultiRepoView;
	projectId: string | null;
	orchestrations: MultiRepoOrchestration[];
	activeId: string | null;
	pickedRepos: PickedRepo[];
	taskDescription: string;
	busy: boolean;
	/** A `multiRepo:` i18n key. */
	error: string | null;

	openDialog: (projectId: string) => Promise<void>;
	closeDialog: () => void;
	showList: () => void;
	showNew: () => void;
	showDetail: (id: string) => void;
	toggleRepo: (repo: PickedRepo) => void;
	setTaskDescription: (text: string) => void;
	launch: () => Promise<void>;
	start: (id: string) => Promise<void>;
	stop: (id: string) => Promise<void>;
	applyUpdate: (orchestration: MultiRepoOrchestration) => void;
}

const emptyForm = { pickedRepos: [] as PickedRepo[], taskDescription: "" };

function api() {
	return typeof window === "undefined" ? undefined : window.electronAPI;
}

export const useMultiRepoStore = create<MultiRepoState>((set, get) => ({
	isDialogOpen: false,
	view: "list",
	projectId: null,
	orchestrations: [],
	activeId: null,
	...emptyForm,
	busy: false,
	error: null,

	openDialog: async (projectId) => {
		set({ isDialogOpen: true, projectId, error: null, activeId: null, view: "list" });
		const result = await api()?.listMultiRepoOrchestrations(projectId);
		if (get().projectId !== projectId) return;
		const orchestrations = result?.success && result.data ? result.data : [];
		set({ orchestrations, view: orchestrations.length > 0 ? "list" : "new" });
	},

	closeDialog: () => set({ isDialogOpen: false, error: null }),
	showList: () => set({ view: "list", activeId: null, error: null }),
	showNew: () => set({ view: "new", activeId: null, error: null, ...emptyForm }),
	showDetail: (id) => set({ view: "detail", activeId: id, error: null }),

	toggleRepo: (repo) =>
		set((state) => ({
			pickedRepos: state.pickedRepos.some((r) => r.path === repo.path)
				? state.pickedRepos.filter((r) => r.path !== repo.path)
				: [...state.pickedRepos, repo],
		})),

	setTaskDescription: (text) => set({ taskDescription: text }),

	launch: async () => {
		const { projectId, pickedRepos, taskDescription } = get();
		const electron = api();
		if (!projectId || !electron) return;
		set({ busy: true, error: null });
		try {
			const created = await electron.createMultiRepoOrchestration(projectId, {
				repos: pickedRepos.map((r) => ({ localPath: r.path })),
				taskDescription: taskDescription.trim(),
			});
			if (!created.success || !created.data) {
				set({ error: created.error ?? "errors.createFailed" });
				return;
			}
			const orchestration = created.data;
			set((state) => ({
				orchestrations: [orchestration, ...state.orchestrations],
				activeId: orchestration.id,
				view: "detail",
				...emptyForm,
			}));
			// A folder picked in the form became a project of this computer.
			void loadProjects();
			const started = await electron.startMultiRepoOrchestration(projectId, orchestration.id);
			if (!started.success) set({ error: started.error ?? "errors.startFailed" });
		} finally {
			set({ busy: false });
		}
	},

	start: async (id) => {
		const { projectId } = get();
		const result = projectId
			? await api()?.startMultiRepoOrchestration(projectId, id)
			: undefined;
		if (result && !result.success) set({ error: result.error ?? "errors.startFailed" });
	},

	stop: async (id) => {
		const { projectId } = get();
		if (projectId) await api()?.stopMultiRepoOrchestration(projectId, id);
	},

	applyUpdate: (orchestration) =>
		set((state) => {
			if (orchestration.projectId !== state.projectId) return {};
			const known = state.orchestrations.some((o) => o.id === orchestration.id);
			return {
				orchestrations: known
					? state.orchestrations.map((o) => (o.id === orchestration.id ? orchestration : o))
					: [orchestration, ...state.orchestrations],
			};
		}),
}));

/** Opens the dialog for `projectId`. */
export function openMultiRepoDialog(projectId: string): void {
	void useMultiRepoStore.getState().openDialog(projectId);
}

/** Follows the runs of the main process; answers the cleanup. */
export function setupMultiRepoListeners(): () => void {
	const electron = api();
	if (!electron?.onMultiRepoUpdated) return () => undefined;
	return electron.onMultiRepoUpdated((orchestration) =>
		useMultiRepoStore.getState().applyUpdate(orchestration),
	);
}
