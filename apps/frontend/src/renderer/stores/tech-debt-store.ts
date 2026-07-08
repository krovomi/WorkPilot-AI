/**
 * Tech Debt Store — ROI-scored debt dashboard state.
 */

import { create } from "zustand";
import type {
	DebtItem,
	DebtSummary,
	DebtTrendPoint,
} from "../../preload/api/modules/tech-debt-api";
import type { Task } from "../../shared/types";
import { buildDebtTaskSpec, type Lang } from "../lib/debt-task-spec";
import { createTask } from "./task-store";

export interface TechDebtFilters {
	minScore: number;
	kind: string | null;
	search: string;
}

interface TechDebtState {
	items: DebtItem[];
	trend: DebtTrendPoint[];
	summary: DebtSummary | null;
	filters: TechDebtFilters;
	scanning: boolean;
	error: string | null;
	lastScannedAt: number | null;

	setFilter: <K extends keyof TechDebtFilters>(
		key: K,
		value: TechDebtFilters[K],
	) => void;
	scan: (projectPath: string) => Promise<void>;
	refresh: (projectPath: string) => Promise<void>;
	generateSpec: (
		projectPath: string,
		itemId: string,
		llmHint?: string,
	) => Promise<string | null>;
	createTaskFromItem: (
		projectId: string,
		item: DebtItem,
		lang: Lang,
	) => Promise<Task | null>;
	clear: () => void;
}

const DEFAULT_FILTERS: TechDebtFilters = {
	minScore: 0,
	kind: null,
	search: "",
};

export const useTechDebtStore = create<TechDebtState>((set, get) => ({
	items: [],
	trend: [],
	summary: null,
	filters: DEFAULT_FILTERS,
	scanning: false,
	error: null,
	lastScannedAt: null,

	setFilter: (key, value) =>
		set((state) => ({ filters: { ...state.filters, [key]: value } })),

	scan: async (projectPath) => {
		const api = globalThis.electronAPI;
		if (!api?.scanTechDebt) {
			set({ error: "Tech Debt API unavailable" });
			return;
		}
		set({ scanning: true, error: null });
		try {
			const { result } = await api.scanTechDebt({ projectPath });
			set({
				items: result.items,
				trend: result.trend,
				summary: result.summary,
				scanning: false,
				lastScannedAt: result.scanned_at,
			});
		} catch (e) {
			set({ error: String(e), scanning: false });
		}
	},

	refresh: async (projectPath) => {
		const api = globalThis.electronAPI;
		if (!api?.listDebtItems) return;
		try {
			const { result } = await api.listDebtItems({
				projectPath,
				minScore: get().filters.minScore,
			});
			set({
				items: result.items,
				trend: result.trend,
				summary: result.summary,
			});
		} catch (e) {
			set({ error: String(e) });
		}
	},

	generateSpec: async (projectPath, itemId, llmHint) => {
		const api = globalThis.electronAPI;
		if (!api?.generateDebtSpec) {
			set({ error: "Tech Debt API unavailable" });
			return null;
		}
		try {
			const { result } = await api.generateDebtSpec({
				projectPath,
				itemId,
				llmHint,
			});
			return result.spec_dir;
		} catch (e) {
			set({ error: String(e) });
			return null;
		}
	},

	// Turn a debt item into a real Kanban task (backlog). Unlike generateSpec
	// (which wrote an orphan spec folder with no card), this creates a task the
	// user can see, open and launch from the board.
	createTaskFromItem: async (projectId, item, lang) => {
		const { title, description, acceptanceCriteria } = buildDebtTaskSpec(
			item,
			lang,
		);
		try {
			const task = await createTask(projectId, title, description, {
				sourceType: "tech-debt",
				acceptanceCriteria,
			});
			if (!task) {
				set({ error: "Failed to create task from debt item" });
				return null;
			}
			return task;
		} catch (e) {
			set({ error: String(e) });
			return null;
		}
	},

	clear: () =>
		set({ items: [], trend: [], summary: null, error: null }),
}));
