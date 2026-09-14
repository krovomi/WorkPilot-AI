/**
 * The documents of the Visual-to-Code canvas, and their construction history.
 *
 * Shared because three processes need to agree on the shape: the renderer
 * writes it, preload carries it, and the main process is what actually stores
 * it. The history lives on disk rather than in `localStorage` — sixty
 * snapshots of a forty-block architecture, times however many architectures
 * are open, is megabytes against a quota the whole app shares, and a quota
 * that overflows loses exactly the work this feature exists to protect.
 */

/** One block or connection named in a timeline row. */
export interface ChangeEntry {
	kind: "added" | "removed" | "changed";
	label: string;
}

/**
 * What happened between two versions, computed once when the version is
 * captured rather than by diffing on every render — the row has to say the
 * same thing in six weeks as it did the moment it was written.
 */
export interface ChangeSummary {
	addedNodes: number;
	removedNodes: number;
	changedNodes: number;
	addedEdges: number;
	removedEdges: number;
	/** A bounded sample of the names involved, most interesting first. */
	sample: ChangeEntry[];
}

/**
 * A version without its bodies.
 *
 * This is what the history panel lists and what crosses IPC when it opens: the
 * renderer never holds sixty sets of nodes and edges to draw sixty rows.
 */
export interface ArchitectureVersionMeta {
	id: string;
	/** ISO timestamp. */
	createdAt: string;
	/** A name the user gave this step; auto-captured versions have none. */
	label: string | null;
	/**
	 * Kept whatever happens. Auto-captured versions fall off the bottom once
	 * the cap is reached; a version somebody named is a decision, and a
	 * decision is not something a cap gets to discard.
	 */
	pinned: boolean;
	nodeCount: number;
	edgeCount: number;
	/** Absent on the first version of an architecture: nothing preceded it. */
	summary: ChangeSummary | null;
	/** Set when this version was written by restoring an earlier one. */
	restoredFrom: string | null;
}

/** A version with the diagram it captured. */
export interface ArchitectureVersion extends ArchitectureVersionMeta {
	diagramType: string;
	nodes: unknown[];
	edges: unknown[];
}

/** What the renderer sends to capture a step; the store assigns id and time. */
export interface ArchitectureVersionInput {
	label?: string | null;
	pinned?: boolean;
	summary?: ChangeSummary | null;
	restoredFrom?: string | null;
	diagramType: string;
	nodes: unknown[];
	edges: unknown[];
}

/**
 * How many *unpinned* versions an architecture keeps. Pinned ones are not
 * counted and are never dropped — see `pinned` above.
 */
export const ARCHITECTURE_HISTORY_LIMIT = 60;
