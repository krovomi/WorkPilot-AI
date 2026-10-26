import { create } from "zustand";
import type { BenchStatus } from "../../shared/types";

/**
 * The repo bench's last known status, per project. A run outlives the page:
 * its builds run in the main process for an hour or more, so the event
 * listener lives for the window (`setupBenchListeners`) and the page reads.
 */
interface BenchState {
	statusByProject: Record<string, BenchStatus>;
	setStatus: (projectId: string, status: BenchStatus) => void;
}

export const useBenchStore = create<BenchState>((set) => ({
	statusByProject: {},
	setStatus: (projectId, status) =>
		set((state) => ({
			statusByProject: { ...state.statusByProject, [projectId]: status },
		})),
}));

export function setupBenchListeners(): () => void {
	return globalThis.electronAPI.onBenchEvent((projectId, status) => {
		useBenchStore.getState().setStatus(projectId, status);
	});
}
