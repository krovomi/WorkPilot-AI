import { useCallback, useMemo } from "react";
import {
	DEFAULT_SIDEBAR_PREFS,
	type SidebarPrefs,
} from "@shared/types/settings";
import { saveSettings, useSettingsStore } from "@/stores/settings-store";

// Reorder an array by moving `id` from its current position to the position of `overId`.
// If either id is missing, the array is returned unchanged so callers don't have to null-check.
function arrayMoveById(list: string[], id: string, overId: string): string[] {
	const from = list.indexOf(id);
	const to = list.indexOf(overId);
	if (from === -1 || to === -1 || from === to) return list;
	const next = list.slice();
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}

// Merge user-defined order with the authoritative list from code. Unknown ids in prefs
// (features removed from the codebase) are dropped; new ids not yet in prefs keep their
// default order and are appended after the user-ordered ones.
function mergeOrder(preferred: string[], actual: string[]): string[] {
	const actualSet = new Set(actual);
	const preferredValid = preferred.filter((id) => actualSet.has(id));
	const preferredSet = new Set(preferredValid);
	const missing = actual.filter((id) => !preferredSet.has(id));
	return [...preferredValid, ...missing];
}

export function useSidebarPrefs() {
	const prefs = useSettingsStore(
		(state) => state.settings.sidebarPrefs ?? DEFAULT_SIDEBAR_PREFS,
	);

	const update = useCallback((patch: Partial<SidebarPrefs>) => {
		const current =
			useSettingsStore.getState().settings.sidebarPrefs ??
			DEFAULT_SIDEBAR_PREFS;
		const next: SidebarPrefs = { ...current, ...patch };
		saveSettings({ sidebarPrefs: next });
	}, []);

	const toggleItemPin = useCallback(
		(itemId: string) => {
			const current =
				useSettingsStore.getState().settings.sidebarPrefs ??
				DEFAULT_SIDEBAR_PREFS;
			const isPinned = current.pinnedItems.includes(itemId);
			update({
				pinnedItems: isPinned
					? current.pinnedItems.filter((id) => id !== itemId)
					: [...current.pinnedItems, itemId],
			});
		},
		[update],
	);

	// One write for several ids: a hub's entry can carry pins left on its tabs
	// from before they were tabs, and two toggles would race on the save.
	const unpinItems = useCallback(
		(itemIds: readonly string[]) => {
			const current =
				useSettingsStore.getState().settings.sidebarPrefs ??
				DEFAULT_SIDEBAR_PREFS;
			update({
				pinnedItems: current.pinnedItems.filter((id) => !itemIds.includes(id)),
			});
		},
		[update],
	);

	const toggleGroupPin = useCallback(
		(groupId: string) => {
			const current =
				useSettingsStore.getState().settings.sidebarPrefs ??
				DEFAULT_SIDEBAR_PREFS;
			const isPinned = current.pinnedGroups.includes(groupId);
			update({
				pinnedGroups: isPinned
					? current.pinnedGroups.filter((id) => id !== groupId)
					: [...current.pinnedGroups, groupId],
			});
		},
		[update],
	);

	const reorderGroups = useCallback(
		(activeId: string, overId: string, actualOrder: string[]) => {
			const current =
				useSettingsStore.getState().settings.sidebarPrefs ??
				DEFAULT_SIDEBAR_PREFS;
			const merged = mergeOrder(current.groupOrder, actualOrder);
			update({ groupOrder: arrayMoveById(merged, activeId, overId) });
		},
		[update],
	);

	const reorderItems = useCallback(
		(
			groupId: string,
			activeId: string,
			overId: string,
			actualOrder: string[],
		) => {
			const current =
				useSettingsStore.getState().settings.sidebarPrefs ??
				DEFAULT_SIDEBAR_PREFS;
			const existing = current.itemOrder[groupId] ?? [];
			const merged = mergeOrder(existing, actualOrder);
			const next = arrayMoveById(merged, activeId, overId);
			update({ itemOrder: { ...current.itemOrder, [groupId]: next } });
		},
		[update],
	);

	const setHideExperimental = useCallback(
		(value: boolean) => update({ hideExperimental: value }),
		[update],
	);

	const setActiveSpace = useCallback(
		(spaceId: string) => update({ activeSpace: spaceId }),
		[update],
	);

	// « Essentiel » pins the essential pages (keeping the user's own pins) and
	// hides the beta views; « Complet » only records the choice.
	const chooseMenuMode = useCallback(
		(mode: "essential" | "full", essentialIds: readonly string[] = []) => {
			const current =
				useSettingsStore.getState().settings.sidebarPrefs ??
				DEFAULT_SIDEBAR_PREFS;
			if (mode === "full") {
				update({ menuMode: "full" });
				return;
			}
			const pinned = [
				...current.pinnedItems,
				...essentialIds.filter((id) => !current.pinnedItems.includes(id)),
			];
			update({ menuMode: "essential", pinnedItems: pinned, hideExperimental: true });
		},
		[update],
	);

	const hideItems = useCallback(
		(ids: readonly string[]) => {
			const current =
				useSettingsStore.getState().settings.sidebarPrefs ??
				DEFAULT_SIDEBAR_PREFS;
			const hidden = current.hiddenItems ?? [];
			update({ hiddenItems: [...hidden, ...ids.filter((id) => !hidden.includes(id))] });
		},
		[update],
	);

	const unhideItem = useCallback(
		(id: string) => {
			const current =
				useSettingsStore.getState().settings.sidebarPrefs ??
				DEFAULT_SIDEBAR_PREFS;
			update({ hiddenItems: (current.hiddenItems ?? []).filter((x) => x !== id) });
		},
		[update],
	);

	const snoozeHideSuggestions = useCallback(
		(until: number) => update({ hideSuggestionsSnoozedUntil: until }),
		[update],
	);

	const reset = useCallback(() => {
		saveSettings({ sidebarPrefs: DEFAULT_SIDEBAR_PREFS });
	}, []);

	return useMemo(
		() => ({
			prefs,
			toggleItemPin,
			unpinItems,
			toggleGroupPin,
			reorderGroups,
			reorderItems,
			setHideExperimental,
			setActiveSpace,
			chooseMenuMode,
			hideItems,
			unhideItem,
			snoozeHideSuggestions,
			reset,
			mergeOrder,
		}),
		[
			prefs,
			toggleItemPin,
			unpinItems,
			toggleGroupPin,
			reorderGroups,
			reorderItems,
			setHideExperimental,
			setActiveSpace,
			chooseMenuMode,
			hideItems,
			unhideItem,
			snoozeHideSuggestions,
			reset,
		],
	);
}
