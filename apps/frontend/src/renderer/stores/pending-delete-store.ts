import { create } from "zustand";
import { deleteTasks } from "./task-store";

/** How long a deleted card waits, hidden, before it is really deleted. */
export const DEFERRED_DELETE_MS = 8000;

interface PendingDeleteState {
	/** Cards deleted but not yet gone: the board hides them. */
	ids: ReadonlySet<string>;
	hide: (ids: readonly string[]) => void;
	show: (ids: readonly string[]) => void;
}

export const usePendingDeleteStore = create<PendingDeleteState>((set) => ({
	ids: new Set(),
	hide: (ids) =>
		set((state) => ({ ids: new Set([...state.ids, ...ids]) })),
	show: (ids) =>
		set((state) => {
			const next = new Set(state.ids);
			for (const id of ids) next.delete(id);
			return { ids: next };
		}),
}));

export interface PendingDelete {
	/** Brings the cards back; false once they are already deleted. */
	cancel: () => boolean;
}

/**
 * Hides the cards now and deletes them after DEFERRED_DELETE_MS, unless
 * cancelled first. Nothing is deleted if the window closes before that. A
 * card that could not be deleted comes back, and `onFailed` says so.
 */
export function deleteLater(
	ids: readonly string[],
	onFailed: (error?: string) => void,
): PendingDelete {
	const store = usePendingDeleteStore.getState();
	store.hide(ids);
	let settled = false;
	const timer = setTimeout(async () => {
		settled = true;
		const result = await deleteTasks([...ids]);
		usePendingDeleteStore.getState().show(ids);
		if (!result.success) onFailed(result.error);
	}, DEFERRED_DELETE_MS);
	return {
		cancel: () => {
			if (settled) return false;
			settled = true;
			clearTimeout(timer);
			usePendingDeleteStore.getState().show(ids);
			return true;
		},
	};
}
