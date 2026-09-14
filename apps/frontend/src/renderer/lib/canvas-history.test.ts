import { describe, expect, it } from "vitest";
import {
	canRedo,
	canUndo,
	commit,
	describeChange,
	type HistoryEdge,
	type HistoryNode,
	initHistory,
	isEmptyChange,
	redo,
	signature,
	type Snapshot,
	structuralSignature,
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


// ── The persisted timeline ────────────────────────────────────────────

describe("structuralSignature", () => {
	it("ignores a move, which `signature` counts", () => {
		const before = snap([node("1", "FrontEnd", 0, 0)]);
		const after = snap([node("1", "FrontEnd", 400, 120)]);

		// A drag is a real edit and undo must take it back…
		expect(signature(before)).not.toBe(signature(after));
		// …but it is not a construction step, and a timeline of "moved a block"
		// forty times is one nobody scrolls through.
		expect(structuralSignature(before)).toBe(structuralSignature(after));
	});

	it("counts a rename, a role change and a stack change", () => {
		const base = snap([{ id: "1", data: { label: "a", type: "backend" } }]);

		for (const changed of [
			{ id: "1", data: { label: "b", type: "backend" } },
			{ id: "1", data: { label: "a", type: "frontend" } },
			{ id: "1", data: { label: "a", type: "backend", framework: "DotNet" } },
		]) {
			expect(structuralSignature(snap([changed]))).not.toBe(
				structuralSignature(base),
			);
		}
	});

	it("counts a connection, and its label", () => {
		const two = [node("1"), node("2")];
		const bare = snap(two, [edge("e", "1", "2")]);
		const labelled = snap(two, [
			{ ...edge("e", "1", "2"), data: { label: "HTTP / REST" } },
		]);

		expect(structuralSignature(snap(two))).not.toBe(structuralSignature(bare));
		expect(structuralSignature(bare)).not.toBe(structuralSignature(labelled));
	});

	it("does not depend on the order blocks happen to be in", () => {
		const a = snap([node("1", "x"), node("2", "y")]);
		const b = snap([node("2", "y"), node("1", "x")]);

		expect(structuralSignature(a)).toBe(structuralSignature(b));
	});
});

describe("describeChange", () => {
	it("names what was added, because that is what a timeline is scanned for", () => {
		const summary = describeChange(
			snap([]),
			snap([node("1", "FrontEnd React"), node("2", "BackEnd DotNet")]),
		);

		expect(summary.addedNodes).toBe(2);
		expect(summary.sample.map((entry) => entry.label)).toEqual([
			"FrontEnd React",
			"BackEnd DotNet",
		]);
		expect(summary.sample.every((entry) => entry.kind === "added")).toBe(true);
	});

	it("separates a removal from a change of the same block", () => {
		const before = snap([node("1", "Api"), node("2", "Db")]);
		const after = snap([node("1", "Gateway")]);
		const summary = describeChange(before, after);

		expect(summary.changedNodes).toBe(1);
		expect(summary.removedNodes).toBe(1);
		expect(summary.addedNodes).toBe(0);
		expect(summary.sample).toContainEqual({ kind: "removed", label: "Db" });
		expect(summary.sample).toContainEqual({ kind: "changed", label: "Gateway" });
	});

	it("counts connections in both directions", () => {
		const nodes = [node("1"), node("2"), node("3")];
		const summary = describeChange(
			snap(nodes, [edge("a", "1", "2")]),
			snap(nodes, [edge("b", "2", "3"), edge("c", "1", "3")]),
		);

		expect(summary.addedEdges).toBe(2);
		expect(summary.removedEdges).toBe(1);
	});

	it("bounds the names it carries, so one row stays one row", () => {
		const many = Array.from({ length: 20 }, (_, i) =>
			node(String(i), `Block ${i}`),
		);
		const summary = describeChange(snap([]), snap(many));

		expect(summary.addedNodes).toBe(20);
		// The count says twenty; the row shows a handful.
		expect(summary.sample.length).toBeLessThanOrEqual(4);
	});

	it("falls back to the id rather than showing an empty name", () => {
		const summary = describeChange(
			snap([]),
			snap([{ id: "node-7", data: { label: "   " } }]),
		);

		expect(summary.sample[0]).toEqual({ kind: "added", label: "node-7" });
	});

	it("reports a move as nothing happening", () => {
		const summary = describeChange(
			snap([node("1", "Api", 0, 0)]),
			snap([node("1", "Api", 500, 500)]),
		);

		expect(isEmptyChange(summary)).toBe(true);
	});
});
