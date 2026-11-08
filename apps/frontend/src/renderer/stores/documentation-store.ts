import { create } from "zustand";
import type {
	DocDraftResult,
	DocFileReport,
	DocProjectOverview,
	DocReadmeResult,
	DocumentationAction,
} from "../../shared/types/documentation";

/**
 * The Documentation tab's state, kept per project path so switching tabs or
 * projects does not lose a report (the runner is quick, but a large project
 * still takes a few seconds).
 */
interface DocumentationState {
	projectPath: string | null;
	running: DocumentationAction | null;
	status: string;
	error: string | null;
	overview: DocProjectOverview | null;
	file: DocFileReport | null;
	drafts: DocDraftResult | null;
	readme: DocReadmeResult | null;
	selectedSymbol: string | null;
	draftsView: "docs" | "readme";

	bindProject: (projectPath: string) => void;
	run: (action: DocumentationAction, path?: string) => Promise<void>;
	cancel: () => Promise<void>;
	setStatus: (status: string) => void;
	selectSymbol: (key: string | null) => void;
	setDraftsView: (view: "docs" | "readme") => void;
}

const EMPTY = {
	running: null,
	status: "",
	error: null,
	overview: null,
	file: null,
	drafts: null,
	readme: null,
	selectedSymbol: null,
} as const;

export const useDocumentationStore = create<DocumentationState>((set, get) => ({
	projectPath: null,
	draftsView: "docs",
	...EMPTY,

	bindProject: (projectPath) => {
		if (get().projectPath !== projectPath) set({ projectPath, ...EMPTY });
	},

	run: async (action, path) => {
		const projectPath = get().projectPath;
		if (!projectPath) return;
		set({ running: action, status: "", error: null });
		try {
			const api = globalThis.electronAPI;
			if (action === "project") {
				const overview = await api.runDocumentation({ projectPath, action });
				if (get().projectPath === projectPath) set({ overview });
			} else if (action === "coverage") {
				const file = await api.runDocumentation({ projectPath, action, path });
				if (get().projectPath === projectPath) set({ file, selectedSymbol: null });
			} else if (action === "docstrings") {
				const [file, drafts] = await Promise.all([
					get().file?.path === path
						? Promise.resolve(get().file)
						: api.runDocumentation({ projectPath, action: "coverage", path }),
					api.runDocumentation({ projectPath, action, path }),
				]);
				if (get().projectPath === projectPath) set({ file, drafts, draftsView: "docs" });
			} else {
				const readme = await api.runDocumentation({ projectPath, action, path });
				if (get().projectPath === projectPath) set({ readme, draftsView: "readme" });
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// "Error invoking remote method 'x': Error: reason" -> "reason"
			set({ error: message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") });
		} finally {
			set({ running: null, status: "" });
		}
	},

	cancel: async () => {
		await globalThis.electronAPI.cancelDocumentation();
		set({ running: null, status: "" });
	},

	setStatus: (status) => set({ status }),
	selectSymbol: (selectedSymbol) => set({ selectedSymbol }),
	setDraftsView: (draftsView) => set({ draftsView }),
}));
