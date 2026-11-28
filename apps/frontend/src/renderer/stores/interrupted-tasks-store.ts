/**
 * The builds the last exit interrupted, as the launch offered them
 * (main/ipc-handlers/task/interrupted-prompt.ts): the dialog reads `offer`,
 * the toast reads `autoResumed`.
 */
import { create } from "zustand";
import type { InterruptedTask, InterruptedTasksOffer } from "../../shared/types/interrupted-tasks";
import { useProjectStore } from "./project-store";
import { loadTasks } from "./task-store";

interface InterruptedTasksState {
	/** Waiting for the person's answer: the dialog is open while it is set. */
	offer: InterruptedTask[] | null;
	/** Resumed by the « Tout reprendre » setting: a toast says which, once. */
	autoResumed: InterruptedTask[] | null;
	receive: (offer: InterruptedTasksOffer | null) => void;
	close: () => void;
	clearAutoResumed: () => void;
}

/**
 * The cards changed on disk: a launch settles a crash into the shutdown pause,
 * an answer resumes some builds and puts the others off. The board rereads
 * them so it shows « Interrompue », not a stale « En cours » that turns stuck.
 */
function reloadBoard(): void {
	const projectId = useProjectStore.getState().selectedProjectId;
	if (projectId) void loadTasks(projectId, { forceRefresh: true });
}

export const useInterruptedTasksStore = create<InterruptedTasksState>((set) => ({
	offer: null,
	autoResumed: null,
	receive: (offer) => {
		if (!offer || offer.tasks.length === 0) return;
		if (offer.mode === "resumed") {
			const ids = new Set(offer.resumed ?? []);
			set({ autoResumed: offer.tasks.filter((t) => ids.has(t.taskId)) });
		} else {
			set({ offer: offer.tasks });
		}
		reloadBoard();
	},
	close: () => {
		set({ offer: null });
		reloadBoard();
	},
	clearAutoResumed: () => set({ autoResumed: null }),
}));

let teardown: (() => void) | null = null;

/** Registered once by `global-listeners.ts`; idempotent. */
export function setupInterruptedTasksListeners(): () => void {
	if (teardown) return teardown;
	const api = globalThis.electronAPI;
	const unsubscribers: Array<() => void> = [];
	const store = useInterruptedTasksStore.getState();
	if (typeof api?.onInterruptedTasksOffer === "function") {
		unsubscribers.push(api.onInterruptedTasksOffer((offer) => store.receive(offer)));
	}
	// The offer may have been sent before this window listened (a reload).
	if (typeof api?.getInterruptedTasks === "function") {
		void api
			.getInterruptedTasks()
			.then((offer) => {
				if (!useInterruptedTasksStore.getState().offer) store.receive(offer);
			})
			.catch(() => undefined);
	}
	teardown = () => {
		teardown = null;
		for (const unsubscribe of unsubscribers) unsubscribe();
	};
	return teardown;
}
