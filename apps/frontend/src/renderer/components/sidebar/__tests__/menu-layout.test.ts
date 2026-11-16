/**
 * The menu as each person arranges it: the rules are pure, so each one is
 * read on plain groups, with an id the code no longer ships and a new one.
 */
import { DEFAULT_SIDEBAR_PREFS, type SidebarPrefs } from "@shared/types/settings";
import { Star } from "lucide-react";
import { describe, expect, it } from "vitest";
import type { SidebarView } from "../../Sidebar";
import {
	applyMenuLayout,
	arrayMoveBy,
	arrayMoveById,
	hasCustomOrder,
	mergeOrder,
	moveGroupBy,
	moveItemBy,
	moveItemToGroup,
	movePinBy,
	neighbourOf,
	reorderGroup,
	reorderItem,
	reorderPins,
	SHIPPED_ORDER,
} from "../menu-layout";
import type { NavGroup } from "../nav-model";

const group = (id: string, ...items: string[]): NavGroup => ({
	id,
	labelKey: id,
	icon: Star,
	items: items.map((item) => ({ id: item as SidebarView, labelKey: item, icon: Star })),
});
const SHIPPED = [group("a", "k", "d", "m"), group("b", "t", "p"), group("c", "r")];
const prefs = (patch: Partial<SidebarPrefs> = {}): SidebarPrefs => ({ ...DEFAULT_SIDEBAR_PREFS, ...patch });
const ids = (groups: readonly NavGroup[]) => groups.map((g) => `${g.id}:${g.items.map((i) => i.id).join("")}`);

describe("lists", () => {
	it("merges a saved order with the ids the code ships", () => {
		expect(mergeOrder(["gone", "m", "k"], ["k", "d", "m"])).toEqual(["m", "k", "d"]);
	});

	it("moves an id to another's place, or by a step held in bounds", () => {
		expect(arrayMoveById(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
		expect(arrayMoveById(["a", "b"], "a", "x")).toEqual(["a", "b"]);
		expect(arrayMoveBy(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
		expect(arrayMoveBy(["a", "b"], "a", -1)).toEqual(["a", "b"]);
		expect(arrayMoveBy(["a", "b"], "x", 1)).toEqual(["a", "b"]);
		expect(neighbourOf(["a", "b"], "b", -1)).toBe("a");
		expect(neighbourOf(["a", "b"], "b", 1)).toBeNull();
		expect(neighbourOf(["a"], "x", 1)).toBeNull();
	});
});

describe("applyMenuLayout", () => {
	it("is the shipped menu when nothing is arranged", () => {
		expect(ids(applyMenuLayout(SHIPPED, prefs()))).toEqual(["a:kdm", "b:tp", "c:r"]);
	});

	it("moves pages, then orders spaces and pages, and drops an emptied space", () => {
		const arranged = applyMenuLayout(
			SHIPPED,
			prefs({
				groupOrder: ["b", "gone", "a"],
				itemOrder: { b: ["k", "t"], a: ["m"] },
				itemGroups: { k: "b", r: "a", d: "nowhere" },
			}),
		);
		expect(ids(arranged)).toEqual(["b:ktp", "a:mdr"]);
	});
});

describe("moving pages", () => {
	const arranged = applyMenuLayout(SHIPPED, prefs());

	it("reorders a page inside its space, not across spaces", () => {
		expect(reorderItem(prefs(), arranged, "a", "m", "k")).toEqual({ itemOrder: { a: ["m", "k", "d"] } });
		expect(reorderItem(prefs(), arranged, "a", "k", "t")).toBeNull();
		expect(reorderItem(prefs(), arranged, "a", "k", "k")).toBeNull();
	});

	it("moves a page one step among the pages shown, past a hidden one", () => {
		// d is hidden: k going down passes it and lands after m.
		expect(moveItemBy(prefs(), arranged, "a", "k", 1, ["k", "m"])).toEqual({ itemOrder: { a: ["d", "m", "k"] } });
		expect(moveItemBy(prefs(), arranged, "a", "k", -1)).toBeNull();
		expect(moveItemBy(prefs(), arranged, "a", "m", 1)).toBeNull();
		expect(moveItemBy(prefs(), arranged, "gone", "k", 1)).toBeNull();
	});

	it("moves a page to another space, and forgets the move back home", () => {
		const there = moveItemToGroup(prefs(), SHIPPED, arranged, "k", "b");
		expect(there).toEqual({ itemGroups: { k: "b" }, itemOrder: { a: ["d", "m"], b: ["t", "p", "k"] } });
		const moved = applyMenuLayout(SHIPPED, prefs(there ?? {}));
		expect(ids(moved)).toEqual(["a:dm", "b:tpk", "c:r"]);
		const back = moveItemToGroup(prefs(there ?? {}), SHIPPED, moved, "k", "a");
		expect(back?.itemGroups).toEqual({});
		expect(back?.itemOrder?.a).toEqual(["d", "m", "k"]);
	});

	it("places a moved page at the place of a page of its new space", () => {
		expect(moveItemToGroup(prefs(), SHIPPED, arranged, "k", "b", "t")?.itemOrder?.b).toEqual(["k", "t", "p"]);
	});

	it("refuses a move to its own space, to an unknown space, or of an unknown page", () => {
		expect(moveItemToGroup(prefs(), SHIPPED, arranged, "k", "a")).toBeNull();
		expect(moveItemToGroup(prefs(), SHIPPED, arranged, "k", "zz")).toBeNull();
		expect(moveItemToGroup(prefs(), SHIPPED, arranged, "zz", "b")).toBeNull();
	});
});

describe("moving spaces", () => {
	const arranged = applyMenuLayout(SHIPPED, prefs());

	it("reorders spaces by drop or by a step among those shown", () => {
		expect(reorderGroup(prefs(), arranged, "c", "a")).toEqual({ groupOrder: ["c", "a", "b"] });
		expect(reorderGroup(prefs(), arranged, "c", "c")).toBeNull();
		expect(reorderGroup(prefs(), arranged, "c", "zz")).toBeNull();
		expect(moveGroupBy(prefs(), arranged, "a", 1)).toEqual({ groupOrder: ["b", "a", "c"] });
		expect(moveGroupBy(prefs(), arranged, "a", 1, ["a", "c"])).toEqual({ groupOrder: ["b", "c", "a"] });
		expect(moveGroupBy(prefs(), arranged, "a", -1)).toBeNull();
	});
});

describe("moving pins", () => {
	// A pin is a view id; the hub `h` stands for its tabs h1 and h2.
	const entryOf = (pin: string) => (pin.startsWith("h") ? "h" : pin);

	it("reorders pins by their entries", () => {
		expect(reorderPins(["k", "h2", "t"], entryOf, "t", "h")).toEqual(["k", "t", "h2"]);
		expect(reorderPins(["k", "t"], entryOf, "k", "zz")).toBeNull();
		expect(reorderPins(["k", "t"], entryOf, "k", "k")).toBeNull();
		expect(movePinBy(prefs({ pinnedItems: ["k", "h2", "t"] }), entryOf, "h", -1, ["k", "h", "t"])).toEqual({
			pinnedItems: ["h2", "k", "t"],
		});
		expect(movePinBy(prefs({ pinnedItems: ["k", "t"] }), entryOf, "k", -1, ["k", "t"])).toBeNull();
		// Shown but no longer pinned (a pinned group's page): nothing moves.
		expect(movePinBy(prefs({ pinnedItems: ["t"] }), entryOf, "k", 1, ["k", "t"])).toBeNull();
	});
});

describe("the shipped order", () => {
	it("sees a custom order and restores the shipped one", () => {
		expect(hasCustomOrder(prefs())).toBe(false);
		expect(hasCustomOrder(prefs({ itemGroups: { k: "b" } }))).toBe(true);
		expect(hasCustomOrder(prefs({ groupOrder: ["b"] }))).toBe(true);
		expect(hasCustomOrder(prefs({ itemOrder: { a: ["m"] } }))).toBe(true);
		expect(hasCustomOrder(prefs({ ...SHIPPED_ORDER, pinnedItems: ["k"] }))).toBe(false);
	});
});
