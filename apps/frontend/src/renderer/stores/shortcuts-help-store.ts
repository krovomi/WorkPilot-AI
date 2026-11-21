import { create } from "zustand";

/** The board's keyboard help: opened by Ctrl/Cmd+/, ? or the toolbar. */
export const useShortcutsHelpStore = create<{
	open: boolean;
	setOpen: (open: boolean) => void;
}>((set) => ({
	open: false,
	setOpen: (open) => set({ open }),
}));
