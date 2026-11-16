/** The ids of the menu's sortables: a kind, then the id, and nothing else. */
import { describe, expect, it } from "vitest";
import { decodeSortableId, encodeSortableId, pageDraggedOver } from "../sortable-primitives";

describe("sortable ids", () => {
	it("round-trips each kind and refuses the others", () => {
		for (const kind of ["item", "group", "pin"] as const) {
			expect(decodeSortableId(encodeSortableId(kind, "kanban"))).toEqual({ kind, id: "kanban" });
		}
		expect(decodeSortableId("tab:kanban")).toBeNull();
		expect(decodeSortableId("kanban")).toBeNull();
	});

	it("lights a space of the rail only for a page dragged over it", () => {
		expect(pageDraggedOver(true, "item:kanban")).toBe(true);
		expect(pageDraggedOver(false, "item:kanban")).toBe(false);
		expect(pageDraggedOver(true, "group:agents")).toBe(false);
		expect(pageDraggedOver(true, "pin:kanban")).toBe(false);
		expect(pageDraggedOver(true, undefined)).toBe(false);
	});
});
