import { useCallback, useMemo } from "react";
import {
	DEFAULT_SIDEBAR_PREFS,
	type SidebarPrefs,
} from "@shared/types/settings";
import { saveSettings, useSettingsStore } from "@/stores/settings-store";
import { SHIPPED_ORDER } from "./menu-layout";

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

	// A change to the order (`menu-layout.ts`), built from the preferences as
	// saved now so two quick moves never undo each other; null saves nothing.
	const arrange = useCallback(
		(build: (current: SidebarPrefs) => Partial<SidebarPrefs> | null) => {
			const current =
				useSettingsStore.getState().settings.sidebarPrefs ??
				DEFAULT_SIDEBAR_PREFS;
			const patch = build(current);
			if (patch) update(patch);
		},
		[update],
	);

	// The order as shipped; pins, hidden pages and the menu mode are kept.
	const resetOrder = useCallback(() => update(SHIPPED_ORDER), [update]);

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
			arrange,
			resetOrder,
			setHideExperimental,
			setActiveSpace,
			chooseMenuMode,
			hideItems,
			unhideItem,
			snoozeHideSuggestions,
			reset,
		}),
		[
			prefs,
			toggleItemPin,
			unpinItems,
			toggleGroupPin,
			arrange,
			resetOrder,
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
