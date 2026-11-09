import type { LucideIcon } from "lucide-react";
import { create } from "zustand";
import type { SidebarView } from "../Sidebar";
import { EXPERIMENTAL_VIEWS } from "./experimental-views";
import { getHub, type HubTabGates, shownHubTabs } from "./hubs";
import { itemShown, type NavGroup } from "./nav-model";

/**
 * One page the user can reach from the menu, as the command palette lists it:
 * a plain entry, or each shown tab of a hub entry.
 */
export interface NavIndexEntry {
	readonly view: SidebarView;
	readonly labelKey: string;
	readonly icon: LucideIcon;
	readonly shortcut?: string;
	/** Where the page sits in the menu: its group, then its hub. */
	readonly placeKeys: readonly string[];
	readonly experimental: boolean;
}

/**
 * The pages of the menu as it stands (groups after the gates, the forge
 * entries, the administration), flattened for a search. A hub contributes its
 * shown tabs, each placed under the hub's name.
 */
export function buildNavIndex(
	groups: readonly NavGroup[],
	gates: HubTabGates,
): NavIndexEntry[] {
	const entries: NavIndexEntry[] = [];
	const seen = new Set<SidebarView>();
	const push = (entry: NavIndexEntry) => {
		if (seen.has(entry.view)) return;
		seen.add(entry.view);
		entries.push(entry);
	};
	for (const group of groups) {
		for (const item of group.items) {
			const place = [group.labelKey];
			if (!item.hub) {
				if (!itemShown(item, gates)) continue;
				push({
					view: item.id,
					labelKey: item.labelKey,
					icon: item.icon,
					shortcut: item.shortcut,
					placeKeys: place,
					experimental: EXPERIMENTAL_VIEWS.has(item.id),
				});
				continue;
			}
			const hub = getHub(item.hub);
			for (const tab of shownHubTabs(hub, gates)) {
				push({
					view: tab.view,
					labelKey: tab.labelKey,
					icon: tab.icon,
					shortcut: tab.shortcut,
					placeKeys: [group.labelKey, hub.labelKey],
					experimental: EXPERIMENTAL_VIEWS.has(tab.view),
				});
			}
		}
	}
	return entries;
}

interface NavIndexState {
	entries: readonly NavIndexEntry[];
	setEntries: (entries: readonly NavIndexEntry[]) => void;
}

/**
 * The pages the sidebar shows right now, published by the sidebar: the
 * command palette offers exactly these, under the same gates (server project,
 * forge, hidden beta views), instead of a second hand-written list.
 */
export const useNavIndexStore = create<NavIndexState>((set) => ({
	entries: [],
	setEntries: (entries) => set({ entries }),
}));
