import { create } from "zustand";
import {
	type PanelCardId,
	type PanelSectionId,
	sectionOfCard,
} from "../components/task-detail/panel-sections";

/**
 * The task panel's own UI state, for the session.
 *
 * - `section`: the tab of the Overview last opened (Progress, Quality, Costs &
 *   context). Kept in memory, not in `localStorage`: opening the next task on
 *   the tab one was reading is the convenience; a choice that survives a
 *   restart would hide the Progress tab of a task that needs you.
 * - `pendingReveal`: a card the "waiting for you" banner asked to show. The
 *   card's slot scrolls to it once the card is on screen (it may load
 *   asynchronously, or the Overview may not be mounted yet), then clears it.
 */
interface TaskPanelState {
	section: PanelSectionId;
	pendingReveal: { taskId: string; card: PanelCardId } | null;
	setSection: (section: PanelSectionId) => void;
	reveal: (taskId: string, card: PanelCardId) => void;
	clearReveal: () => void;
}

export const useTaskPanelStore = create<TaskPanelState>((set) => ({
	section: "progress",
	pendingReveal: null,
	setSection: (section) => set({ section }),
	reveal: (taskId, card) =>
		set({ section: sectionOfCard(card), pendingReveal: { taskId, card } }),
	clearReveal: () => set({ pendingReveal: null }),
}));
