import { create } from "zustand";

/**
 * Tasks a person asked to set aside from the board (a drop on « Abandonnée »,
 * a menu), waiting for the reason dialog (kanban/AbandonRequestDialog.tsx).
 */
interface AbandonRequestState {
	/** Ids of the tasks the open dialog abandons; empty while it is closed. */
	ids: readonly string[];
	request: (ids: readonly string[]) => void;
	close: () => void;
}

export const useAbandonRequestStore = create<AbandonRequestState>((set) => ({
	ids: [],
	request: (ids) => set({ ids: [...new Set(ids)] }),
	close: () => set({ ids: [] }),
}));
