import type { SidebarPrefs } from "@shared/types/settings";
import type { NavGroup } from "./nav-model";

/**
 * The menu as each person arranges it: spaces in their order, pages in
 * their order inside each space, pages moved to another space, pins in
 * their order. The rules are here, pure; `use-sidebar-prefs.ts` saves what
 * they return, the sidebar applies them to the groups the code ships.
 *
 * Every rule is permissive with ids: one the code no longer ships is
 * dropped, one it ships but the person never placed keeps its shipped place
 * after theirs, so adding or removing a page needs no settings migration.
 */

/** The ids of `preferred` the code still ships, then the others in code order. */
export function mergeOrder(preferred: readonly string[], actual: readonly string[]): string[] {
	const actualSet = new Set(actual);
	const preferredValid = preferred.filter((id) => actualSet.has(id));
	const preferredSet = new Set(preferredValid);
	return [...preferredValid, ...actual.filter((id) => !preferredSet.has(id))];
}

/** `list` with `id` moved to the place of `overId`; unchanged when either is missing. */
export function arrayMoveById(list: readonly string[], id: string, overId: string): string[] {
	const from = list.indexOf(id);
	const to = list.indexOf(overId);
	if (from === -1 || to === -1 || from === to) return [...list];
	const next = list.slice();
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}

/** `list` with `id` moved `delta` places, held inside the list's bounds. */
export function arrayMoveBy(list: readonly string[], id: string, delta: number): string[] {
	const from = list.indexOf(id);
	if (from === -1) return [...list];
	const to = Math.max(0, Math.min(list.length - 1, from + delta));
	if (to === from) return [...list];
	return arrayMoveById(list, id, list[to]);
}

/**
 * The groups as the person arranged them: each page moved to the space they
 * chose (when that space is shown), the spaces in their order, the pages of
 * each space in their order.
 */
export function applyMenuLayout(
	groups: readonly NavGroup[],
	prefs: Pick<SidebarPrefs, "groupOrder" | "itemOrder" | "itemGroups">,
): NavGroup[] {
	const shown = new Set(groups.map((group) => group.id));
	const moves = prefs.itemGroups ?? {};
	const placed = groups.map((group) => ({ ...group, items: [] as NavGroup["items"] }));
	const byId = new Map(placed.map((group) => [group.id, group]));
	for (const group of groups) {
		for (const item of group.items) {
			const target = moves[item.id];
			const home = target && shown.has(target) ? target : group.id;
			byId.get(home)?.items.push(item);
		}
	}
	return mergeOrder(prefs.groupOrder, placed.map((group) => group.id))
		.map((id) => byId.get(id))
		.filter((group): group is NavGroup => Boolean(group))
		.map((group) => {
			const itemById = new Map(group.items.map((item) => [item.id as string, item]));
			const order = mergeOrder(prefs.itemOrder[group.id] ?? [], [...itemById.keys()]);
			return { ...group, items: order.map((id) => itemById.get(id)).filter((item) => item !== undefined) };
		})
		.filter((group) => group.items.length > 0);
}

/** The order of a space's pages as shown, for the rules below. */
function orderOf(groups: readonly NavGroup[], groupId: string): string[] {
	return groups.find((group) => group.id === groupId)?.items.map((item) => item.id) ?? [];
}

/** Where the shipped menu puts a page: its home group, whatever the moves. */
function homeOf(shipped: readonly NavGroup[], itemId: string): string | undefined {
	return shipped.find((group) => group.items.some((item) => item.id === itemId))?.id;
}

export type LayoutPatch = Partial<Pick<SidebarPrefs, "groupOrder" | "itemOrder" | "itemGroups">>;

/** Move a page to the place of another page of the same space. */
export function reorderItem(
	prefs: SidebarPrefs,
	arranged: readonly NavGroup[],
	groupId: string,
	itemId: string,
	overId: string,
): LayoutPatch | null {
	const order = orderOf(arranged, groupId);
	if (!order.includes(itemId) || !order.includes(overId) || itemId === overId) return null;
	return {
		itemOrder: {
			...prefs.itemOrder,
			[groupId]: arrayMoveById(mergeOrder(prefs.itemOrder[groupId] ?? [], order), itemId, overId),
		},
	};
}

/** The id `delta` places from `id` in `shown`, if there is one. */
export function neighbourOf(shown: readonly string[], id: string, delta: number): string | null {
	const at = shown.indexOf(id);
	if (at === -1) return null;
	return shown[at + delta] ?? null;
}

/**
 * Move a page one place up (-1) or down (+1) among the pages `shown` in its
 * space; a page hidden or in the Labo keeps its place between them.
 */
export function moveItemBy(
	prefs: SidebarPrefs,
	arranged: readonly NavGroup[],
	groupId: string,
	itemId: string,
	delta: number,
	shown: readonly string[] = orderOf(arranged, groupId),
): LayoutPatch | null {
	const neighbour = neighbourOf(shown, itemId, delta);
	return neighbour ? reorderItem(prefs, arranged, groupId, itemId, neighbour) : null;
}

/**
 * Move a page to another space, at the end of it (or at the place of
 * `overId` when it is one of that space's pages). Moving it back to the
 * space the code ships it in forgets the move.
 */
export function moveItemToGroup(
	prefs: SidebarPrefs,
	shipped: readonly NavGroup[],
	arranged: readonly NavGroup[],
	itemId: string,
	targetId: string,
	overId?: string,
): LayoutPatch | null {
	const from = arranged.find((group) => group.items.some((item) => item.id === itemId));
	if (!from || from.id === targetId || !shipped.some((group) => group.id === targetId)) return null;
	const moves = { ...(prefs.itemGroups ?? {}) };
	if (homeOf(shipped, itemId) === targetId) delete moves[itemId];
	else moves[itemId] = targetId;
	const target = [...orderOf(arranged, targetId), itemId];
	const placed = overId ? arrayMoveById(target, itemId, overId) : target;
	return {
		itemGroups: moves,
		itemOrder: {
			...prefs.itemOrder,
			[from.id]: orderOf(arranged, from.id).filter((id) => id !== itemId),
			[targetId]: placed,
		},
	};
}

/** Move a space to the place of another (the rail, dragged with the pointer). */
export function reorderGroup(
	prefs: SidebarPrefs,
	arranged: readonly NavGroup[],
	groupId: string,
	overId: string,
): LayoutPatch | null {
	const order = arranged.map((group) => group.id);
	if (!order.includes(groupId) || !order.includes(overId) || groupId === overId) return null;
	return { groupOrder: arrayMoveById(mergeOrder(prefs.groupOrder, order), groupId, overId) };
}

/** Move a space one place up (-1) or down (+1) among the spaces `shown` in the rail. */
export function moveGroupBy(
	prefs: SidebarPrefs,
	arranged: readonly NavGroup[],
	groupId: string,
	delta: number,
	shown: readonly string[] = arranged.map((group) => group.id),
): LayoutPatch | null {
	const neighbour = neighbourOf(shown, groupId, delta);
	return neighbour ? reorderGroup(prefs, arranged, groupId, neighbour) : null;
}

/**
 * Pins in a new order: `entryId` (a menu entry, a hub's entry included) at
 * the place of `overId`. Pins are saved by view id, so each entry is found
 * through `entryOf`.
 */
export function reorderPins(
	pinned: readonly string[],
	entryOf: (pin: string) => string,
	entryId: string,
	overId: string,
): string[] | null {
	const from = pinned.findIndex((pin) => entryOf(pin) === entryId);
	const to = pinned.findIndex((pin) => entryOf(pin) === overId);
	if (from === -1 || to === -1 || from === to) return null;
	return arrayMoveById(pinned, pinned[from], pinned[to]);
}

/** Move a pin one place up (-1) or down (+1) among the entries `shown`. */
export function movePinBy(
	prefs: SidebarPrefs,
	entryOf: (pin: string) => string,
	entryId: string,
	delta: number,
	shown: readonly string[],
): Pick<SidebarPrefs, "pinnedItems"> | null {
	const neighbour = neighbourOf(shown, entryId, delta);
	const pinnedItems = neighbour ? reorderPins(prefs.pinnedItems, entryOf, entryId, neighbour) : null;
	return pinnedItems ? { pinnedItems } : null;
}

/** Whether the person changed the order of anything (spaces, pages, moves). */
export function hasCustomOrder(prefs: SidebarPrefs): boolean {
	return (
		prefs.groupOrder.length > 0 ||
		Object.keys(prefs.itemOrder).length > 0 ||
		Object.keys(prefs.itemGroups ?? {}).length > 0
	);
}

/** The order as shipped, pins and hidden pages kept. */
export const SHIPPED_ORDER: Required<LayoutPatch> = { groupOrder: [], itemOrder: {}, itemGroups: {} };
