import { create } from "zustand";

/**
 * The tasks a person is flagging « Bloquée » from the board (a card menu,
 * the selection bar), waiting for the reason dialog (kanban/FlagRequestDialog.tsx).
 */
interface FlagRequestState {
	/** Ids of the tasks the open dialog flags; empty while it is closed. */
	ids: readonly string[];
	request: (ids: readonly string[]) => void;
	close: () => void;
}

export const useFlagRequestStore = create<FlagRequestState>((set) => ({
	ids: [],
	request: (ids) => set({ ids: [...new Set(ids)] }),
	close: () => set({ ids: [] }),
}));
