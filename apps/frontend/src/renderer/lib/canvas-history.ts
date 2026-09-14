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

import type {
	ChangeEntry,
	ChangeSummary,
} from "../../shared/types/visual-to-code-history";

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


// ── The persisted timeline ────────────────────────────────────────────
//
// Undo/redo above is about the last few seconds and dies with the session.
// What follows feeds the *history* of an architecture: which construction
// steps happened, so one of them can be returned to days later. The two
// answer different questions and take snapshots on different rules.

/**
 * A snapshot's identity **ignoring positions**.
 *
 * Dragging a block is an edit — `signature` counts it, and undo should take
 * it back. It is not a *construction step*: a timeline whose rows read "moved
 * a block", forty times, is a timeline nobody scrolls through. So the history
 * captures when the structure changes, and the positions of that moment ride
 * along inside the snapshot rather than creating rows of their own.
 */
export function structuralSignature<N extends HistoryNode, E extends HistoryEdge>(
	snapshot: Snapshot<N, E>,
): string {
	const nodes = snapshot.nodes
		.map((n) =>
			[
				n.id,
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

/** How many names a summary carries. The row is one line; the counts say the rest. */
export const CHANGE_SAMPLE_LIMIT = 4;

/** The name to show for a block, falling back to its id rather than to nothing. */
function nodeLabel(node: HistoryNode): string {
	const label = node.data?.label?.trim();
	return label || node.id;
}

/**
 * What changed between two snapshots.
 *
 * Computed once, when the version is captured, because the row has to read the
 * same in six weeks — and because diffing two forty-block documents on every
 * render of a sixty-row list is work nobody asked for.
 *
 * The sample leads with what was added: "what did I just put in?" is the
 * question a timeline is scanned for, and a row that only counts ("3 blocs")
 * answers it for nobody.
 */
export function describeChange<N extends HistoryNode, E extends HistoryEdge>(
	previous: Snapshot<N, E>,
	next: Snapshot<N, E>,
): ChangeSummary {
	const before = new Map(previous.nodes.map((n) => [n.id, n]));
	const after = new Map(next.nodes.map((n) => [n.id, n]));

	const added: ChangeEntry[] = [];
	const removed: ChangeEntry[] = [];
	const changed: ChangeEntry[] = [];

	for (const [id, node] of after) {
		const old = before.get(id);
		if (!old) {
			added.push({ kind: "added", label: nodeLabel(node) });
			continue;
		}
		// A rename, a different role, or a different stack: three edits that
		// leave the block in place and that the counts alone would hide.
		if (
			old.data?.label !== node.data?.label ||
			old.data?.type !== node.data?.type ||
			old.data?.framework !== node.data?.framework
		) {
			changed.push({ kind: "changed", label: nodeLabel(node) });
		}
	}
	for (const [id, node] of before) {
		if (!after.has(id)) removed.push({ kind: "removed", label: nodeLabel(node) });
	}

	const beforeEdges = new Set(previous.edges.map((e) => e.id));
	const afterEdges = new Set(next.edges.map((e) => e.id));
	let addedEdges = 0;
	let removedEdges = 0;
	for (const id of afterEdges) if (!beforeEdges.has(id)) addedEdges++;
	for (const id of beforeEdges) if (!afterEdges.has(id)) removedEdges++;

	return {
		addedNodes: added.length,
		removedNodes: removed.length,
		changedNodes: changed.length,
		addedEdges,
		removedEdges,
		sample: [...added, ...removed, ...changed].slice(0, CHANGE_SAMPLE_LIMIT),
	};
}

/** Whether a summary describes anything at all — an empty one is not a step. */
export function isEmptyChange(summary: ChangeSummary): boolean {
	return (
		summary.addedNodes === 0 &&
		summary.removedNodes === 0 &&
		summary.changedNodes === 0 &&
		summary.addedEdges === 0 &&
		summary.removedEdges === 0
	);
}
