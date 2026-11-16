/**
 * The layout of the menu that crosses to the server: every id a menu id,
 * every list bounded, the same arrangement compared whatever the key order.
 */
import { describe, expect, it } from "vitest";
import {
	isDefaultMenuLayout,
	MAX_MENU_ENTRIES,
	MAX_MENU_GROUPS,
	menuLayoutOf,
	parseMenuLayout,
	sameMenuLayout,
} from "../menu-layout";

const LAYOUT = {
	groupOrder: ["agents"],
	itemOrder: { agents: ["terminals"] },
	itemGroups: { kanban: "agents" },
	pinnedItems: ["github-prs"],
	pinnedGroups: ["planning"],
	hiddenItems: ["arena"],
};

describe("parseMenuLayout", () => {
	it("keeps a layout, and drops a repeated id", () => {
		expect(parseMenuLayout(LAYOUT)).toEqual(LAYOUT);
		expect(parseMenuLayout({ ...LAYOUT, pinnedItems: ["kanban", "kanban"] })?.pinnedItems).toEqual(["kanban"]);
	});

	it.each([
		["a non-object", "layout"],
		["an array", []],
		["null", null],
		["a missing list", { ...LAYOUT, hiddenItems: undefined }],
		["an id with capitals", { ...LAYOUT, groupOrder: ["Agents"] }],
		["a path", { ...LAYOUT, pinnedItems: ["../etc"] }],
		["an id too long", { ...LAYOUT, pinnedItems: ["a".repeat(65)] }],
		["a non-string id", { ...LAYOUT, hiddenItems: [3] }],
		["too many groups", { ...LAYOUT, groupOrder: Array.from({ length: MAX_MENU_GROUPS + 1 }, (_, i) => `g${i}`) }],
		["too many pins", { ...LAYOUT, pinnedItems: Array.from({ length: MAX_MENU_ENTRIES + 1 }, (_, i) => `p${i}`) }],
		["a bad group key", { ...LAYOUT, itemOrder: { Agents: ["kanban"] } }],
		["a bad order", { ...LAYOUT, itemOrder: { agents: "kanban" } }],
		["an order as an array", { ...LAYOUT, itemOrder: [] }],
		["a bad move target", { ...LAYOUT, itemGroups: { kanban: "../x" } }],
		["a move to a non-string", { ...LAYOUT, itemGroups: { kanban: 1 } }],
		["too many moves", { ...LAYOUT, itemGroups: Object.fromEntries(Array.from({ length: MAX_MENU_ENTRIES + 1 }, (_, i) => [`p${i}`, "agents"])) }],
	])("refuses %s", (_name, value) => {
		expect(parseMenuLayout(value)).toBeNull();
	});
});

describe("comparing layouts", () => {
	it("fills the defaults and sees the shipped menu", () => {
		expect(isDefaultMenuLayout(menuLayoutOf(undefined))).toBe(true);
		expect(isDefaultMenuLayout(menuLayoutOf({ activeSpace: "planning" }))).toBe(true);
		expect(isDefaultMenuLayout(menuLayoutOf(LAYOUT))).toBe(false);
	});

	it("ignores the key order of the records, not the order of the lists", () => {
		const a = menuLayoutOf({ ...LAYOUT, itemOrder: { a: ["x"], b: ["y"] } });
		const b = menuLayoutOf({ ...LAYOUT, itemOrder: { b: ["y"], a: ["x"] } });
		expect(sameMenuLayout(a, b)).toBe(true);
		expect(sameMenuLayout(a, { ...a, groupOrder: ["planning", "agents"] })).toBe(false);
	});
});
