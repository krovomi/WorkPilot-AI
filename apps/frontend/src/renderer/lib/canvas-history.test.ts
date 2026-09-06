import { describe, expect, it } from "vitest";
import {
	canRedo,
	canUndo,
	commit,
	type HistoryEdge,
	type HistoryNode,
	initHistory,
	redo,
	signature,
	type Snapshot,
	undo,
} from "./canvas-history";

const node = (
	id: string,
	label = "n",
	x = 0,
	y = 0,
): HistoryNode => ({
	id,
	position: { x, y },
	data: { label },
});

const edge = (id: string, source: string, target: string): HistoryEdge => ({
	id,
	source,
	target,
});

const snap = (
	nodes: HistoryNode[],
	edges: HistoryEdge[] = [],
): Snapshot => ({ nodes, edges });

describe("signature", () => {
	it("is stable across array order", () => {
		const a = snap([node("1"), node("2")], [edge("e", "1", "2")]);
		const b = snap([node("2"), node("1")], [edge("e", "1", "2")]);
		expect(signature(a)).toBe(signature(b));
	});

	it("changes when a label changes", () => {
		expect(signature(snap([node("1", "before")]))).not.toBe(
			signature(snap([node("1", "after")])),
		);
	});

	it("changes when a node moves", () => {
		expect(signature(snap([node("1", "n", 0, 0)]))).not.toBe(
			signature(snap([node("1", "n", 40, 0)])),
		);
	});

	it("ignores selection — selecting a block is not an edit", () => {
		const plain = snap([node("1")]);
		const selected = snap([{ ...node("1"), selected: true } as HistoryNode]);
		expect(signature(selected)).toBe(signature(plain));
	});

	it("does not confuse two states that concatenate to the same text", () => {
		// Without a field separator, id "ab" + label "c" and id "a" + label "bc"
		// would produce the same string and one of the two edits would be lost.
		expect(signature(snap([node("ab", "c")]))).not.toBe(
			signature(snap([node("a", "bc")])),
		);
	});
});

describe("commit", () => {
	it("records a changed snapshot", () => {
		const h = initHistory(snap([node("1")]));
		const next = commit(h, snap([node("1"), node("2")]));
		expect(next.past).toHaveLength(1);
		expect(canUndo(next)).toBe(true);
	});

	it("ignores a snapshot equal to the present one", () => {
		const h = initHistory(snap([node("1")]));
		expect(commit(h, snap([node("1")]))).toBe(h);
	});

	it("drops the oldest entries past the limit", () => {
		let h = initHistory(snap([node("1", "0")]));
		for (let i = 1; i <= 10; i++) h = commit(h, snap([node("1", String(i))]), 3);
		expect(h.past).toHaveLength(3);
	});

	it("clears the redo stack — a new edit forks the timeline", () => {
		const h = commit(initHistory(snap([node("1")])), snap([node("2")]));
		const back = undo(h);
		expect(canRedo(back)).toBe(true);
		expect(canRedo(commit(back, snap([node("3")])))).toBe(false);
	});
});

describe("undo / redo", () => {
	it("walks back and forward through the states", () => {
		let h = initHistory(snap([node("1", "a")]));
		h = commit(h, snap([node("1", "b")]));
		h = commit(h, snap([node("1", "c")]));

		h = undo(h);
		expect(h.present.nodes[0].data?.label).toBe("b");
		h = undo(h);
		expect(h.present.nodes[0].data?.label).toBe("a");
		h = redo(h);
		expect(h.present.nodes[0].data?.label).toBe("b");
	});

	it("is a no-op at either end of the stack", () => {
		const h = initHistory(snap([node("1")]));
		expect(undo(h)).toBe(h);
		expect(redo(h)).toBe(h);
		expect(canUndo(h)).toBe(false);
		expect(canRedo(h)).toBe(false);
	});

	it("restores edges too, not only nodes", () => {
		let h = initHistory(snap([node("1"), node("2")], [edge("e", "1", "2")]));
		h = commit(h, snap([node("1"), node("2")], []));
		expect(undo(h).present.edges).toHaveLength(1);
	});
});
