import { create } from "zustand";
import type { AutomationsEvent } from "../../shared/types";
import { useProjectStore } from "./project-store";
import { loadTasks } from "./task-store";

/**
 * The last pass the main process announced, per project. The settings panel
 * re-reads its rules when the count moves; the board reloads its tasks when
 * a pass created cards for the open project.
 */
interface AutomationsStoreState {
	passes: Record<string, number>;
	announce: (event: AutomationsEvent) => void;
}

export const useAutomationsStore = create<AutomationsStoreState>((set) => ({
	passes: {},
	announce: (event) =>
		set((state) => ({
			passes: {
				...state.passes,
				[event.projectId]: (state.passes[event.projectId] ?? 0) + 1,
			},
		})),
}));

export function setupAutomationsListeners(): () => void {
	return globalThis.electronAPI.automations.onEvent((event) => {
		useAutomationsStore.getState().announce(event);
		if (
			event.created > 0 &&
			useProjectStore.getState().selectedProjectId === event.projectId
		) {
			void loadTasks(event.projectId, { forceRefresh: true });
		}
	});
}
