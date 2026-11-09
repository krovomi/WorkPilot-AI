import type { SidebarView } from "../Sidebar";
import { EXPERIMENTAL_VIEWS } from "./experimental-views";
import { entryIdOfView, type HubTabGates } from "./hubs";
import { hubTabItems, itemViews, type NavGroup, type NavItem } from "./nav-model";

/**
 * The menu in two levels (F181, lot 2): a rail of spaces, one per group plus
 * « Mon menu », and a panel that lists only the space chosen. A space is a
 * group's id; « Mon menu » has its own.
 */
export const MINE_SPACE = "__mine__";

/** The group whose entries stand for this view, if any. */
export function groupOfView(
	groups: readonly NavGroup[],
	view: SidebarView | null,
): NavGroup | undefined {
	if (!view) return undefined;
	return groups.find((group) => group.items.some((item) => itemViews(item).includes(view)));
}

/**
 * The space the panel shows: the one chosen if it still exists, else « Mon
 * menu » when it has something to show, else the group of the page on screen,
 * else the first group.
 */
export function resolveSpace(
	chosen: string | undefined,
	groups: readonly NavGroup[],
	mineHasContent: boolean,
	activeView: SidebarView | null,
): string {
	if (chosen === MINE_SPACE) return MINE_SPACE;
	if (chosen && groups.some((group) => group.id === chosen)) return chosen;
	if (mineHasContent) return MINE_SPACE;
	return groupOfView(groups, activeView)?.id ?? groups[0]?.id ?? MINE_SPACE;
}

/**
 * Whether the panel should move to another space for the page now on screen:
 * a page opened from the palette, a shortcut or a notification shows its
 * group, unless the space on screen already lists it.
 */
export function spaceToFollow(
	current: string,
	groups: readonly NavGroup[],
	mineItems: readonly NavItem[],
	view: SidebarView | null,
): string | null {
	if (!view) return null;
	const listed = (items: readonly NavItem[]) =>
		items.some((item) => itemViews(item).includes(view));
	if (current === MINE_SPACE) {
		if (listed(mineItems)) return null;
	} else {
		const group = groups.find((g) => g.id === current);
		if (group && listed(group.items)) return null;
	}
	const target = groupOfView(groups, view);
	return target && target.id !== current ? target.id : null;
}

/**
 * The menu entries of the pages opened last, most recent first: a hub's tab
 * counts for its hub's entry, a page already pinned is left out (it is just
 * above), and a page the menu no longer shows is skipped.
 */
export function recentNavItems(
	usage: Partial<Record<SidebarView, { lastVisitedAt: number }>>,
	groups: readonly NavGroup[],
	pinned: ReadonlySet<string>,
	limit = 5,
): NavItem[] {
	const byId = new Map(groups.flatMap((group) => group.items).map((item) => [item.id, item]));
	const out: NavItem[] = [];
	const seen = new Set<string>();
	const visits = (Object.entries(usage) as Array<[SidebarView, { lastVisitedAt: number }]>).sort(
		(a, b) => b[1].lastVisitedAt - a[1].lastVisitedAt,
	);
	for (const [view] of visits) {
		const id = entryIdOfView(view);
		const item = byId.get(id);
		if (!item || seen.has(id) || itemViews(item).some((v) => pinned.has(v))) continue;
		seen.add(id);
		out.push(item);
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * The pages the « Essentiel » menu pins: the board, the agents at work, the
 * review, what the codebase is and where it goes, the branches. Each is a
 * stable page (none is beta); one the menu does not show is skipped.
 */
export const ESSENTIAL_VIEWS: readonly SidebarView[] = [
	"kanban",
	"dashboard",
	"terminals",
	"code-review",
	"test-generation",
	"insights",
	"context",
	"roadmap",
	"worktrees",
	"github-prs",
];

/** The Labo (F181, lot 3): the beta pages, apart from the stable ones. */
export const LABO_SPACE = "__labo__";

/**
 * The groups as the rail shows them: without the entries in beta (they go to
 * the Labo) nor the ones the user hid, and without a group left empty. An
 * entry out of beta is back in its group, at its place.
 */
export function railGroupsOf(
	groups: readonly NavGroup[],
	hidden: ReadonlySet<string>,
): NavGroup[] {
	return groups
		.map((group) => ({
			...group,
			items: group.items.filter(
				(item) => (item.hub || !EXPERIMENTAL_VIEWS.has(item.id)) && !hidden.has(item.id),
			),
		}))
		.filter((group) => group.items.length > 0);
}

/**
 * The pages the Labo lists: every beta page the menu shows, a hub's beta tab
 * included (it stays a tab of its hub too). One card each.
 */
export function laboItemsOf(groups: readonly NavGroup[], gates: HubTabGates): NavItem[] {
	const out: NavItem[] = [];
	for (const item of groups.flatMap((group) => group.items)) {
		for (const page of hubTabItems(item, gates)) {
			if (EXPERIMENTAL_VIEWS.has(page.id) && !out.some((p) => p.id === page.id)) out.push(page);
		}
	}
	return out;
}

/** How long a page goes unopened before the menu offers to hide it. */
export const UNUSED_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The entries of a space not opened for `UNUSED_DAYS` days, which the menu
 * offers to hide (it never hides one by itself). Nothing is offered before
 * the usage count is that old, and a pinned entry is never offered. A hub
 * counts as opened when any of its tabs was.
 */
export function unusedEntries(
	items: readonly NavItem[],
	usage: Partial<Record<SidebarView, { lastVisitedAt: number }>>,
	since: number,
	now: number,
	pinned: ReadonlySet<string>,
): NavItem[] {
	const cutoff = now - UNUSED_DAYS * DAY_MS;
	if (since > cutoff) return [];
	return items.filter((item) => {
		const views = itemViews(item);
		if (views.some((view) => pinned.has(view))) return false;
		return !views.some((view) => (usage[view]?.lastVisitedAt ?? 0) >= cutoff);
	});
}
