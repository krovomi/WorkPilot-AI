/**
 * The part of the menu a person arranges for themselves: the order of the
 * spaces, the order of the pages in each, the pages moved to another space,
 * the pins and the pages hidden. Kept in `AppSettings.sidebarPrefs`; in
 * server mode the same layout follows the person to their other desktops
 * (`main/server-ui-preferences.ts`, `GET/PUT /users/me/preferences/menu`).
 *
 * Shared by the renderer and the main: the main checks what the server
 * sends before it reaches the settings file, the server checks it again.
 */

import type { SidebarPrefs } from "../types/settings";

export interface MenuLayout {
	groupOrder: string[];
	itemOrder: Record<string, string[]>;
	itemGroups: Record<string, string>;
	pinnedItems: string[];
	pinnedGroups: string[];
	hiddenItems: string[];
}

/** A page, hub or group id as the menu names them (`nav-model.ts`, `hubs.ts`). */
export const MENU_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Bounds well above the menu's size (about 80 pages in 10 groups). */
export const MAX_MENU_GROUPS = 64;
export const MAX_MENU_ENTRIES = 300;

function idList(value: unknown, max: number): string[] | null {
	if (!Array.isArray(value) || value.length > max) return null;
	const out: string[] = [];
	for (const id of value) {
		if (typeof id !== "string" || !MENU_ID.test(id)) return null;
		if (!out.includes(id)) out.push(id);
	}
	return out;
}

function record(value: unknown, max: number): Array<[string, unknown]> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const entries = Object.entries(value);
	if (entries.length > max) return null;
	return entries.every(([key]) => MENU_ID.test(key)) ? entries : null;
}

/** A layout whose every id and size is checked, or null. */
export function parseMenuLayout(value: unknown): MenuLayout | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const groupOrder = idList(raw.groupOrder, MAX_MENU_GROUPS);
	const pinnedItems = idList(raw.pinnedItems, MAX_MENU_ENTRIES);
	const pinnedGroups = idList(raw.pinnedGroups, MAX_MENU_GROUPS);
	const hiddenItems = idList(raw.hiddenItems, MAX_MENU_ENTRIES);
	const orders = record(raw.itemOrder, MAX_MENU_GROUPS);
	const moves = record(raw.itemGroups, MAX_MENU_ENTRIES);
	if (!groupOrder || !pinnedItems || !pinnedGroups || !hiddenItems || !orders || !moves) {
		return null;
	}
	const itemOrder: Record<string, string[]> = {};
	for (const [group, ids] of orders) {
		const list = idList(ids, MAX_MENU_ENTRIES);
		if (!list) return null;
		itemOrder[group] = list;
	}
	const itemGroups: Record<string, string> = {};
	for (const [item, group] of moves) {
		if (typeof group !== "string" || !MENU_ID.test(group)) return null;
		itemGroups[item] = group;
	}
	return { groupOrder, itemOrder, itemGroups, pinnedItems, pinnedGroups, hiddenItems };
}

/** The layout fields of the sidebar preferences, defaults filled in. */
export function menuLayoutOf(prefs: Partial<SidebarPrefs> | undefined): MenuLayout {
	return {
		groupOrder: prefs?.groupOrder ?? [],
		itemOrder: prefs?.itemOrder ?? {},
		itemGroups: prefs?.itemGroups ?? {},
		pinnedItems: prefs?.pinnedItems ?? [],
		pinnedGroups: prefs?.pinnedGroups ?? [],
		hiddenItems: prefs?.hiddenItems ?? [],
	};
}

/** Whether two layouts arrange the menu the same way. */
export function sameMenuLayout(a: MenuLayout, b: MenuLayout): boolean {
	return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(layout: MenuLayout): unknown {
	const sortKeys = <T>(value: Record<string, T>) =>
		Object.keys(value)
			.sort()
			.map((key) => [key, value[key]]);
	return [
		layout.groupOrder,
		sortKeys(layout.itemOrder),
		sortKeys(layout.itemGroups),
		layout.pinnedItems,
		layout.pinnedGroups,
		layout.hiddenItems,
	];
}

/** Whether the person changed anything from the menu as shipped. */
export function isDefaultMenuLayout(layout: MenuLayout): boolean {
	return sameMenuLayout(layout, menuLayoutOf(undefined));
}
