/**
 * canvas-layout — arrange the diagram into readable left-to-right layers.
 *
 * Blocks land wherever the cursor dropped them, and after five or six drops an
 * architecture reads as a pile rather than a flow. Every real diagram tool
 * answers this with one button, and the arrangement is not a matter of taste
 * here: the connection rules already encode a direction (frontend → backend →
 * database), so "which column is this in?" has a correct answer — the longest
 * path from a node with no inbound edge.
 *
 * Pure: takes nodes and edges, returns the same nodes with new positions.
 */

export interface LayoutNode {
	id: string;
	position: { x: number; y: number };
}

export interface LayoutEdge {
	source: string;
	target: string;
}

export interface LayoutOptions {
	columnGap?: number;
	rowGap?: number;
	originX?: number;
	originY?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
	columnGap: 260,
	rowGap: 120,
	originX: 80,
	originY: 60,
};

/**
 * Depth of every node: 0 for a source, otherwise one past its deepest
 * predecessor. Computed with a queue rather than recursion so a cycle — which
 * the connection rules permit (microservice → microservice) — settles instead
 * of overflowing the stack. Each node is relaxed at most `n` times, the
 * standard longest-path bound, and the counter is what stops a cycle.
 */
export function computeDepths(
	nodes: LayoutNode[],
	edges: LayoutEdge[],
): Map<string, number> {
	const ids = new Set(nodes.map((n) => n.id));
	const clean = edges.filter(
		(e) => e.source !== e.target && ids.has(e.source) && ids.has(e.target),
	);
	const depth = new Map<string, number>(nodes.map((n) => [n.id, 0]));
	const outgoing = new Map<string, string[]>();
	for (const e of clean) {
		const list = outgoing.get(e.source);
		if (list) list.push(e.target);
		else outgoing.set(e.source, [e.target]);
	}
	const relaxed = new Map<string, number>(nodes.map((n) => [n.id, 0]));
	const queue = nodes
		.filter((n) => !clean.some((e) => e.target === n.id))
		.map((n) => n.id);
	// A graph made only of cycles has no source at all — start everywhere so it
	// still gets laid out rather than left untouched.
	if (queue.length === 0) queue.push(...nodes.map((n) => n.id));
	while (queue.length > 0) {
		const id = queue.shift() as string;
		const seen = (relaxed.get(id) ?? 0) + 1;
		relaxed.set(id, seen);
		if (seen > nodes.length) continue;
		const here = depth.get(id) ?? 0;
		for (const target of outgoing.get(id) ?? []) {
			if ((depth.get(target) ?? 0) < here + 1) {
				depth.set(target, here + 1);
				queue.push(target);
			}
		}
	}
	return depth;
}

/**
 * Reposition every node into its depth column, stacked in stable order within
 * the column so re-running the layout does not shuffle the diagram.
 */
export function autoLayout<T extends LayoutNode>(
	nodes: T[],
	edges: LayoutEdge[],
	options: LayoutOptions = {},
): T[] {
	if (nodes.length === 0) return nodes;
	const { columnGap, rowGap, originX, originY } = { ...DEFAULTS, ...options };
	const depth = computeDepths(nodes, edges);
	const rowInColumn = new Map<number, number>();
	return nodes.map((node) => {
		const column = depth.get(node.id) ?? 0;
		const row = rowInColumn.get(column) ?? 0;
		rowInColumn.set(column, row + 1);
		return {
			...node,
			position: {
				x: originX + column * columnGap,
				y: originY + row * rowGap,
			},
		};
	});
}
