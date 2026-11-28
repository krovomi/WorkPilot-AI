import { create } from "zustand";

/**
 * The card whose labels a person is editing from its menu, waiting for the
 * labels dialog (kanban/labels/LabelsDialog.tsx).
 */
interface LabelRequestState {
	/** Id of the card the open dialog edits; null while it is closed. */
	taskId: string | null;
	request: (taskId: string) => void;
	close: () => void;
}

export const useLabelRequestStore = create<LabelRequestState>((set) => ({
	taskId: null,
	request: (taskId) => set({ taskId }),
	close: () => set({ taskId: null }),
}));
