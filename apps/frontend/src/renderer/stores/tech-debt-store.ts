/**
 * Tech Debt Store — ROI-scored debt dashboard state.
 */

import i18n from "i18next";
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
	search: string;
}

interface TechDebtState {
	/** The project the items, trend and summary belong to. */
	projectPath: string | null;
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
	createTaskFromItem: (
		projectId: string,
		item: DebtItem,
		lang: Lang,
	) => Promise<Task | null>;
	/** Reports an error the dashboard found itself. */
	setError: (error: string | null) => void;
	clear: () => void;
}

const DEFAULT_FILTERS: TechDebtFilters = {
	minScore: 0,
	search: "",
};

const EMPTY = {
	items: [],
	trend: [],
	summary: null,
	error: null,
	lastScannedAt: null,
} satisfies Partial<TechDebtState>;

const failure = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useTechDebtStore = create<TechDebtState>((set, get) => {
	// A read for another project empties the view first, and an answer for a
	// view the store has since left is dropped, even when it came back to the
	// same project since: each switch starts a new view.
	let view = 0;
	const switchTo = (projectPath: string): number => {
		if (get().projectPath !== projectPath) {
			view += 1;
			set({ ...EMPTY, projectPath, scanning: false });
		}
		return view;
	};
	const current = (asked: number) => asked === view;

	return {
		projectPath: null,
		...EMPTY,
		filters: DEFAULT_FILTERS,
		scanning: false,

		setFilter: (key, value) =>
			set((state) => ({ filters: { ...state.filters, [key]: value } })),

		scan: async (projectPath) => {
			const asked = switchTo(projectPath);
			set({ scanning: true, error: null });
			try {
				const { result } = await globalThis.electronAPI.scanTechDebt({ projectPath });
				if (!current(asked)) return;
				set({
					items: result.items,
					trend: result.trend,
					summary: result.summary,
					scanning: false,
					lastScannedAt: result.scanned_at,
				});
			} catch (e) {
				if (current(asked)) set({ error: failure(e), scanning: false });
			}
		},

		refresh: async (projectPath) => {
			const asked = switchTo(projectPath);
			try {
				const { result } = await globalThis.electronAPI.listDebtItems({
					projectPath,
					minScore: get().filters.minScore,
				});
				if (!current(asked)) return;
				set({
					items: result.items,
					trend: result.trend,
					summary: result.summary,
				});
			} catch (e) {
				if (current(asked)) set({ error: failure(e) });
			}
		},

		// Turn a debt item into a real Kanban task (backlog) the user can see,
		// open and launch from the board.
		createTaskFromItem: async (projectId, item, lang) => {
			const { title, description, acceptanceCriteria } = buildDebtTaskSpec(
				item,
				lang,
			);
			// createTask reports its own failure and answers null; it never throws.
			const task = await createTask(projectId, title, description, {
				sourceType: "tech-debt",
				acceptanceCriteria,
			});
			if (!task) set({ error: i18n.t("techDebt:errors.createTaskFailed") });
			return task;
		},

		setError: (error) => set({ error }),

		clear: () => {
			view += 1;
			set({ ...EMPTY, projectPath: null, filters: DEFAULT_FILTERS, scanning: false });
		},
	};
});
