import { create } from "zustand";

/** How many board edits Ctrl+Z can take back, most recent first. */
export const UNDO_LIMIT = 20;

export interface UndoEntry {
	/** What the toast says once the edit is undone. */
	label: string;
	/**
	 * Puts things back. Resolves false when it no longer can: the card has
	 * changed since (an agent took it, someone moved it again).
	 */
	undo: () => Promise<boolean>;
}

interface BoardUndoState {
	/** The project the entries belong to. */
	projectId: string | null;
	entries: UndoEntry[];
	/** Starts an empty stack when the board shows another project. */
	forProject: (projectId: string | null) => void;
	push: (entry: UndoEntry) => void;
	pop: () => UndoEntry | undefined;
	clear: () => void;
}

/**
 * The board's undo stack (Ctrl+Z): type and priority changes, moves between
 * Planification and File d'attente, deletions still waiting. Kept for the
 * project on screen only. Design: docs/architecture/kanban-quick-edit.md.
 */
export const useBoardUndoStore = create<BoardUndoState>((set, get) => ({
	projectId: null,
	entries: [],
	forProject: (projectId) => {
		if (get().projectId !== projectId) set({ projectId, entries: [] });
	},
	push: (entry) =>
		set((state) => ({ entries: [...state.entries, entry].slice(-UNDO_LIMIT) })),
	pop: () => {
		const { entries } = get();
		const last = entries.at(-1);
		if (last) set({ entries: entries.slice(0, -1) });
		return last;
	},
	clear: () => set({ entries: [] }),
}));

export function recordUndo(entry: UndoEntry): void {
	useBoardUndoStore.getState().push(entry);
}

/** Undoes the last edit; null when there is nothing to undo. */
export async function undoLast(): Promise<{ label: string; undone: boolean } | null> {
	const entry = useBoardUndoStore.getState().pop();
	if (!entry) return null;
	return { label: entry.label, undone: await entry.undo() };
}
