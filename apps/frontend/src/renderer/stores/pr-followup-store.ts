/**
 * The PR follow-through of each task, as the main process reports it.
 *
 * The card used to keep this in its own state and subscribe to the events
 * while mounted. Two readers need it now — the card and the panel's "waiting
 * for you" banner (red checks the follow-through gave up on) — so it lives
 * here, filled by the event stream registered once by `global-listeners.ts`
 * and by `loadPrFollowupStatus` when a panel opens.
 */
import { create } from "zustand";
import type { PrFollowupStatus } from "../../shared/types";

interface PrFollowupState {
	byTask: Record<string, PrFollowupStatus>;
	set: (taskId: string, status: PrFollowupStatus) => void;
}

export const usePrFollowupStore = create<PrFollowupState>((set) => ({
	byTask: {},
	set: (taskId, status) =>
		set((state) => ({ byTask: { ...state.byTask, [taskId]: status } })),
}));

/** Reads the last known status from main; best effort, events keep it fresh. */
export async function loadPrFollowupStatus(taskId: string): Promise<void> {
	const api = globalThis.electronAPI;
	if (typeof api?.getPrFollowupStatus !== "function") return;
	try {
		const result = await api.getPrFollowupStatus(taskId);
		if (result.success && result.data) {
			usePrFollowupStore.getState().set(taskId, result.data);
		}
	} catch {
		// The event stream keeps the store in sync.
	}
}

let teardown: (() => void) | null = null;

/** Registered once by `global-listeners.ts`; idempotent. */
export function setupPrFollowupListeners(): () => void {
	if (teardown) return teardown;
	const api = globalThis.electronAPI;
	const unsubscribe =
		typeof api?.onPrFollowupEvent === "function"
			? api.onPrFollowupEvent((taskId, status) =>
					usePrFollowupStore.getState().set(taskId, status),
				)
			: undefined;
	teardown = () => {
		teardown = null;
		unsubscribe?.();
	};
	return teardown;
}
