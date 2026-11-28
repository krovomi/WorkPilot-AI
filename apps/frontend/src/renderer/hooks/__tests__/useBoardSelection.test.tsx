import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types";
import { useBoardSelection } from "../useBoardSelection";

const task = (id: string) => ({ id }) as Task;
const column = ["a", "b", "c", "d"];

function setup(tasks = column.map(task)) {
	return renderHook(({ board }) => useBoardSelection(board), {
		initialProps: { board: tasks },
	});
}

const ids = (result: ReturnType<typeof setup>["result"]) => [
	...result.current.selectedTaskIds,
];

describe("useBoardSelection", () => {
	it("toggles a card, then selects the range up to a Shift+click", () => {
		const { result } = setup();
		act(() => result.current.selectGesture("b", "toggle", column));
		act(() => result.current.selectGesture("d", "range", column));
		expect(ids(result).sort()).toEqual(["b", "c", "d"]);
		act(() => result.current.selectGesture("a", "range", column));
		expect(ids(result).sort()).toEqual(["a", "b", "c", "d"]);
		act(() => result.current.selectGesture("c", "toggle", column));
		expect(ids(result).sort()).toEqual(["a", "b", "d"]);
	});

	it("toggles on a Shift+click without an anchor in the column", () => {
		const { result } = setup();
		act(() => result.current.selectGesture("c", "range", column));
		expect(ids(result)).toEqual(["c"]);
		act(() => result.current.selectGesture("x", "toggle", ["x"]));
		act(() => result.current.selectGesture("b", "range", column));
		expect(ids(result).sort()).toEqual(["b", "c", "x"]);
		act(() => result.current.selectGesture("y", "range", column));
		expect(ids(result)).toContain("y");
	});

	it("selects many, clears, and drops cards that left the board", () => {
		const { result, rerender } = setup();
		act(() => result.current.selectTasks(["a", "b"]));
		act(() => result.current.toggleTaskSelection("a"));
		expect(ids(result)).toEqual(["b"]);
		rerender({ board: [task("a")] });
		expect(ids(result)).toEqual([]);
		act(() => result.current.selectTasks(["a"]));
		rerender({ board: [task("a"), task("z")] });
		expect(ids(result)).toEqual(["a"]);
		act(() => result.current.deselectAllTasks());
		expect(ids(result)).toEqual([]);
	});
});
