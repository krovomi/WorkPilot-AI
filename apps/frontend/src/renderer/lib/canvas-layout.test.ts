import { describe, expect, it } from "vitest";
import { autoLayout, computeDepths, type LayoutNode } from "./canvas-layout";

const at = (id: string, x = 0, y = 0): LayoutNode => ({
	id,
	position: { x, y },
});

describe("computeDepths", () => {
	it("puts a source at 0 and each hop one column further", () => {
		const nodes = [at("fe"), at("be"), at("db")];
		const edges = [
			{ source: "fe", target: "be" },
			{ source: "be", target: "db" },
		];
		const depth = computeDepths(nodes, edges);
		expect(depth.get("fe")).toBe(0);
		expect(depth.get("be")).toBe(1);
		expect(depth.get("db")).toBe(2);
	});

	it("takes the longest path, not the first one found", () => {
		// fe → be → db and fe → db: db belongs after be, not beside it.
		const nodes = [at("fe"), at("be"), at("db")];
		const edges = [
			{ source: "fe", target: "be" },
			{ source: "be", target: "db" },
			{ source: "fe", target: "db" },
		];
		expect(computeDepths(nodes, edges).get("db")).toBe(2);
	});

	it("leaves an unconnected node in the first column", () => {
		const depth = computeDepths([at("a"), at("lonely")], []);
		expect(depth.get("lonely")).toBe(0);
	});

	it("terminates on a cycle instead of overflowing", () => {
		// The connection rules allow microservice → microservice, so a cycle is
		// a diagram a user can legitimately draw.
		const nodes = [at("a"), at("b"), at("c")];
		const edges = [
			{ source: "a", target: "b" },
			{ source: "b", target: "c" },
			{ source: "c", target: "a" },
		];
		const depth = computeDepths(nodes, edges);
		expect(depth.size).toBe(3);
		for (const value of depth.values()) {
			expect(Number.isFinite(value)).toBe(true);
		}
	});

	it("ignores edges whose endpoints are gone", () => {
		const depth = computeDepths(
			[at("a"), at("b")],
			[
				{ source: "a", target: "ghost" },
				{ source: "a", target: "b" },
			],
		);
		expect(depth.get("b")).toBe(1);
	});

	it("ignores a self-loop", () => {
		expect(
			computeDepths([at("a")], [{ source: "a", target: "a" }]).get("a"),
		).toBe(0);
	});
});

describe("autoLayout", () => {
	it("lines the chain up left to right", () => {
		const nodes = [at("fe", 900, 900), at("be", 10, 10), at("db", 500, 5)];
		const edges = [
			{ source: "fe", target: "be" },
			{ source: "be", target: "db" },
		];
		const laid = autoLayout(nodes, edges, { columnGap: 100, originX: 0 });
		const byId = new Map(laid.map((n) => [n.id, n.position]));
		expect(byId.get("fe")?.x).toBe(0);
		expect(byId.get("be")?.x).toBe(100);
		expect(byId.get("db")?.x).toBe(200);
	});

	it("stacks siblings in the same column", () => {
		const nodes = [at("be"), at("db"), at("cache")];
		const edges = [
			{ source: "be", target: "db" },
			{ source: "be", target: "cache" },
		];
		const laid = autoLayout(nodes, edges, { rowGap: 50, originY: 0 });
		const byId = new Map(laid.map((n) => [n.id, n.position]));
		expect(byId.get("db")?.x).toBe(byId.get("cache")?.x);
		expect(byId.get("db")?.y).not.toBe(byId.get("cache")?.y);
		expect(Math.abs((byId.get("cache")?.y ?? 0) - (byId.get("db")?.y ?? 0))).toBe(
			50,
		);
	});

	it("is idempotent — running it twice does not shuffle the diagram", () => {
		const nodes = [at("a"), at("b"), at("c")];
		const edges = [
			{ source: "a", target: "b" },
			{ source: "b", target: "c" },
		];
		const once = autoLayout(nodes, edges);
		expect(autoLayout(once, edges)).toEqual(once);
	});

	it("preserves every other field on the node", () => {
		const laid = autoLayout(
			[{ ...at("a"), data: { label: "Keep me" } }],
			[],
		);
		expect(laid[0]).toMatchObject({ id: "a", data: { label: "Keep me" } });
	});

	it("returns an empty diagram untouched", () => {
		expect(autoLayout([], [])).toEqual([]);
	});
});
