import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordUndo, UNDO_LIMIT, undoLast, useBoardUndoStore } from "../board-undo-store";

beforeEach(() => useBoardUndoStore.getState().clear());

describe("board undo stack", () => {
	it("undoes the most recent edit first and keeps the last 20", async () => {
		const undone: number[] = [];
		for (let i = 0; i < UNDO_LIMIT + 3; i++) {
			recordUndo({
				label: `edit ${i}`,
				undo: async () => {
					undone.push(i);
					return true;
				},
			});
		}
		expect(useBoardUndoStore.getState().entries).toHaveLength(UNDO_LIMIT);
		expect(await undoLast()).toEqual({ label: `edit ${UNDO_LIMIT + 2}`, undone: true });
		expect(undone).toEqual([UNDO_LIMIT + 2]);
		expect(useBoardUndoStore.getState().entries[0].label).toBe("edit 3");
	});

	it("starts an empty stack for another project only", () => {
		useBoardUndoStore.getState().forProject("p1");
		recordUndo({ label: "x", undo: async () => true });
		useBoardUndoStore.getState().forProject("p1");
		expect(useBoardUndoStore.getState().entries).toHaveLength(1);
		useBoardUndoStore.getState().forProject("p2");
		expect(useBoardUndoStore.getState().entries).toHaveLength(0);
	});

	it("has nothing to undo once empty", async () => {
		recordUndo({ label: "x", undo: vi.fn(async () => false) });
		expect(await undoLast()).toEqual({ label: "x", undone: false });
		expect(await undoLast()).toBeNull();
	});
});
