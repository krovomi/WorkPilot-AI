import { create } from "zustand";
import type { TaskStatus } from "../../shared/types";

/**
 * Board-level task-dependency surfacing.
 *
 * Same shape and same reason as `kanban-conflict-store`: the board resolves
 * `metadata.blockedBy` for every task in one pass and publishes the result
 * here, so each card reads *its own* entry by id — without prop-drilling a
 * task map through the memoized columns, and without re-rendering every card
 * when one task changes.
 *
 * Entries are summaries, not `Task` objects: the store is compared by
 * reference on every board render, and holding live task instances would make
 * a card re-render on any unrelated change to its blocker.
 */

/** One unfinished blocker, reduced to what a badge and a tooltip need. */
export interface BlockerSummary {
	id: string;
	title: string;
	status: TaskStatus;
}

export interface BoardBlockerInfo {
	/** Blockers that exist and have not finished. Non-empty = task is blocked. */
	pending: BlockerSummary[];
	/** How many declared blockers are already done. */
	resolvedCount: number;
	/** Declared ids with no task behind them. Warned about, never blocking. */
	missing: string[];
}

interface KanbanBlockerState {
	/** Blocker info keyed by task id (absent = nothing declared). */
	blockers: Record<string, BoardBlockerInfo>;
	/** Replace the whole map (the board recomputes it as a batch). */
	setBlockers: (next: Record<string, BoardBlockerInfo>) => void;
	/** Drop everything (e.g. when leaving a project). */
	clear: () => void;
}

export const useKanbanBlockerStore = create<KanbanBlockerState>((set) => ({
	blockers: {},
	setBlockers: (next) => set({ blockers: next }),
	clear: () => set({ blockers: {} }),
}));
