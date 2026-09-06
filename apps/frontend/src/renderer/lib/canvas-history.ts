/**
 * canvas-history — undo / redo for the visual canvas.
 *
 * The canvas had no undo at all: a mis-drop, a stray Delete or an auto-layout
 * was unrecoverable, which is the single most expensive gap in a
 * direct-manipulation editor. ReactFlow does not provide one, so this is the
 * classic past/present/future stack, kept pure so the reducer logic is
 * testable without mounting a canvas.
 *
 * Snapshots are compared by *meaning*, not by reference: dragging a node emits
 * a change on every animation frame, and committing each one would fill the
 * stack with a hundred entries between two meaningful states. `signature`
 * decides what counts as a change — position included (a moved node is a real
 * edit) but selection excluded (selecting is not).
 */

export interface HistoryNode {
	id: string;
	position?: { x: number; y: number };
	data?: { label?: string; type?: string; framework?: string };
}

export interface HistoryEdge {
	id: string;
	source: string;
	target: string;
	data?: { label?: string };
}

export interface Snapshot<
	N extends HistoryNode = HistoryNode,
	E extends HistoryEdge = HistoryEdge,
> {
	nodes: N[];
	edges: E[];
}

export interface History<
	N extends HistoryNode = HistoryNode,
	E extends HistoryEdge = HistoryEdge,
> {
	past: Snapshot<N, E>[];
	present: Snapshot<N, E>;
	future: Snapshot<N, E>[];
}

/** How many undo steps are kept. Older entries fall off the bottom. */
export const HISTORY_LIMIT = 60;

/** Field separator inside a signature — never appears in a label. */
const SEP = "\u001f";

/** A stable string identity for a snapshot — see the note on selection above. */
export function signature<N extends HistoryNode, E extends HistoryEdge>(
	snapshot: Snapshot<N, E>,
): string {
	const nodes = snapshot.nodes
		.map((n) =>
			[
				n.id,
				Math.round(n.position?.x ?? 0),
				Math.round(n.position?.y ?? 0),
				n.data?.label ?? "",
				n.data?.type ?? "",
				n.data?.framework ?? "",
			].join(SEP),
		)
		.sort()
		.join(SEP);
	const edges = snapshot.edges
		.map((e) => [e.id, e.source, e.target, e.data?.label ?? ""].join(SEP))
		.sort()
		.join(SEP);
	return `${nodes}${SEP}${SEP}${edges}`;
}

export function initHistory<N extends HistoryNode, E extends HistoryEdge>(
	present: Snapshot<N, E>,
): History<N, E> {
	return { past: [], present, future: [] };
}

/**
 * Record a new state. A snapshot equal to the present one is ignored rather
 * than pushed, so undo always moves the diagram — an undo that appears to do
 * nothing reads as a broken button.
 */
export function commit<N extends HistoryNode, E extends HistoryEdge>(
	history: History<N, E>,
	next: Snapshot<N, E>,
	limit: number = HISTORY_LIMIT,
): History<N, E> {
	if (signature(next) === signature(history.present)) return history;
	const past = [...history.past, history.present].slice(-limit);
	return { past, present: next, future: [] };
}

export function canUndo(history: History): boolean {
	return history.past.length > 0;
}

export function canRedo(history: History): boolean {
	return history.future.length > 0;
}

export function undo<N extends HistoryNode, E extends HistoryEdge>(
	history: History<N, E>,
): History<N, E> {
	if (history.past.length === 0) return history;
	const previous = history.past[history.past.length - 1];
	return {
		past: history.past.slice(0, -1),
		present: previous,
		future: [history.present, ...history.future],
	};
}

export function redo<N extends HistoryNode, E extends HistoryEdge>(
	history: History<N, E>,
): History<N, E> {
	if (history.future.length === 0) return history;
	const [next, ...rest] = history.future;
	return {
		past: [...history.past, history.present],
		present: next,
		future: rest,
	};
}
