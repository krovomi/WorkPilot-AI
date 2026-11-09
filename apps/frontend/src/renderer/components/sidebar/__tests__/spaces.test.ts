/**
 * The menu in two levels: which space the panel shows, when it follows the
 * page on screen, and what « Mon menu » lists besides the pinned pages.
 */
import { describe, expect, it } from "vitest";
import { EXPERIMENTAL_VIEWS } from "../experimental-views";
import { githubNavItems, navGroups } from "../nav-model";
import {
	ESSENTIAL_VIEWS,
	groupOfView,
	MINE_SPACE,
	recentNavItems,
	resolveSpace,
	spaceToFollow,
} from "../spaces";

const groups = navGroups;
const workspace = groups.find((group) => group.id === "workspace");
const kanban = workspace?.items.find((item) => item.id === "kanban");

describe("groupOfView", () => {
	it("finds the group of a plain page and of a hub's tab", () => {
		expect(groupOfView(groups, "insights")?.id).toBe("explore");
		// « agent-replay » is a tab of the agent-history hub, in the workspace
		expect(groupOfView(groups, "agent-replay")?.id).toBe("workspace");
		expect(groupOfView(groups, null)).toBeUndefined();
	});
});

describe("resolveSpace", () => {
	it("keeps the space chosen while it exists", () => {
		expect(resolveSpace("development", groups, true, "kanban")).toBe("development");
		expect(resolveSpace(MINE_SPACE, groups, false, "kanban")).toBe(MINE_SPACE);
	});

	it("falls back to « Mon menu » when it has something to show", () => {
		expect(resolveSpace("gone-group", groups, true, "insights")).toBe(MINE_SPACE);
	});

	it("else shows the group of the page on screen, else the first group", () => {
		expect(resolveSpace(undefined, groups, false, "insights")).toBe("explore");
		expect(resolveSpace(undefined, groups, false, null)).toBe(groups[0].id);
	});
});

describe("spaceToFollow", () => {
	it("stays when the space shown lists the page", () => {
		expect(spaceToFollow("explore", groups, [], "insights")).toBeNull();
		expect(spaceToFollow(MINE_SPACE, groups, kanban ? [kanban] : [], "kanban")).toBeNull();
	});

	it("moves to the page's group otherwise", () => {
		expect(spaceToFollow("development", groups, [], "insights")).toBe("explore");
		expect(spaceToFollow(MINE_SPACE, groups, [], "insights")).toBe("explore");
	});

	it("stays for a page no group lists", () => {
		expect(spaceToFollow("explore", groups, [], "administration")).toBeNull();
	});
});

describe("recentNavItems", () => {
	it("lists the pages opened last, most recent first, a hub's tab as its hub", () => {
		const recent = recentNavItems(
			{
				kanban: { lastVisitedAt: 1 },
				insights: { lastVisitedAt: 3 },
				"agent-replay": { lastVisitedAt: 2 },
			},
			groups,
			new Set(),
		);
		expect(recent.map((item) => item.id)).toEqual(["insights", "session-history", "kanban"]);
	});

	it("leaves out a pinned page and a page the menu does not show", () => {
		const recent = recentNavItems(
			{ kanban: { lastVisitedAt: 2 }, insights: { lastVisitedAt: 1 } },
			groups.filter((group) => group.id !== "explore"),
			new Set(["kanban"]),
		);
		expect(recent).toEqual([]);
	});

	it("stops at the limit", () => {
		const usage = { kanban: { lastVisitedAt: 1 }, insights: { lastVisitedAt: 2 } };
		expect(recentNavItems(usage, groups, new Set(), 1)).toHaveLength(1);
	});
});

describe("ESSENTIAL_VIEWS", () => {
	it("names pages of the menu, none of them beta", () => {
		const withForge = [...groups, { ...groups[0], id: "forge", items: [...githubNavItems] }];
		for (const view of ESSENTIAL_VIEWS) {
			expect(groupOfView(withForge, view), view).toBeDefined();
			expect(EXPERIMENTAL_VIEWS.has(view), view).toBe(false);
		}
	});
});
