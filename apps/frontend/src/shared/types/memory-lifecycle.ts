/**
 * The memory's lifecycle, as the backend reports it (`apps/backend/brain/lifecycle/`):
 * the journal of every decision, the trash, the pins and the sync conflicts
 * waiting for a person. Codes (`action`, `actor`, `reasonCode`, `signal`) come
 * from closed lists and are translated by the renderer.
 */

export type MemoryLifecycleAction =
	| "create"
	| "update"
	| "forget"
	| "restore"
	| "purge"
	| "pin"
	| "unpin"
	| "protect"
	| "merge"
	| "archive"
	| "resolve"
	| "conflict";

export interface MemoryJournalEntry {
	id: string;
	ts: string;
	action: MemoryLifecycleAction;
	/** `user`, `agent`, `agent:<type>`, `sync`, `learning-loop`, `lifecycle`. */
	actor: string;
	/** The memory's vault path. */
	note: string;
	title: string;
	preview: string;
	reason_code: string;
	reason: string;
	related: string[];
}

export interface TrashedMemory {
	/** The trash id: the note's path inside its memory (`gotchas/x.md`). */
	id: string;
	/** Where it lived, and where Restore puts it back. */
	path: string;
	kind: string;
	title: string;
	preview: string;
	forgotten_at: string;
	forgotten_by: string;
	reason_code: string;
	reason: string;
	restore_until: string;
	pinned: boolean;
	/** Purged within the next 7 days. */
	expiring_soon: boolean;
}

export interface MemoryConflictSide {
	path: string;
	title: string;
	text: string;
	preview: string;
	updated: string;
	pinned: boolean;
	confidence: number | null;
	agents: string[];
	tasks: string[];
}

export type MemoryConflictSignal =
	| "value"
	| "recommendation"
	| "negation"
	| "textual";

export interface MemoryConflict {
	id: string;
	kind: string;
	signal: MemoryConflictSignal;
	detail: string;
	textual: boolean;
	detected_at: string;
	a: MemoryConflictSide;
	b: MemoryConflictSide;
}

export interface MemoryLifecycleView {
	journal: MemoryJournalEntry[];
	trash: TrashedMemory[];
	conflicts: MemoryConflict[];
	pinned: number;
	pinLimit: number;
	retentionDays: number;
}

export type MemoryConflictChoice = "a" | "b" | "custom" | "dismiss";

export interface MemoryConflictOpinion {
	verdict: "contradiction" | "complementary" | "duplicate";
	prefer: "a" | "b" | "none";
	canonical: string;
	reason: string;
}

export interface MemoryRestoreOutcome {
	path: string;
	contradicts: Array<{ path: string; signal: string; detail: string }>;
}
