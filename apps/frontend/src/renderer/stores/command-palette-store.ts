import { create } from "zustand";

interface CommandPaletteState {
	open: boolean;
	setOpen: (open: boolean) => void;
}

/**
 * Whether the command palette is open. A store rather than state of `App`, so
 * the sidebar's search field and Ctrl+K open the same palette.
 */
export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
	open: false,
	setOpen: (open) => set({ open }),
}));

export const openCommandPalette = (): void =>
	useCommandPaletteStore.getState().setOpen(true);
