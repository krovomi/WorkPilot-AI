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
	| "conflict"
	| "designate"
	/** A queued conflict announced on the team's channels (opt-in). */
	| "notify";

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
	/** The id of the entry this one takes back (an undo, a separation). */
	undoes?: string;
	/** For a person's decision: their name, as the vault's git identity says. */
	by?: string;
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
	/** Where the note applies: a module, `team:<name>`, `branch:<name>`; empty: everywhere. */
	applies_to?: string;
}

export type MemoryConflictSignal =
	| "value"
	| "recommendation"
	| "negation"
	| "textual"
	/** A pair whose earlier decision a person took back. */
	| "reopened";

/** The decision a flip-flopping pair overturns: settled by a maintainer. */
export interface MemoryConflictEscalation {
	at: string;
	by: string;
	actor: string;
	reason_code: string;
	/** The pair's scope, whose maintainers settle it (the most specific list). */
	scope?: string;
	maintainers?: string[];
	/** Whether the person at this machine is one of them. */
	can_arbitrate?: boolean;
}

export interface MemoryConflict {
	id: string;
	/** Decided less than the cooldown ago and contradicted again. */
	escalated?: MemoryConflictEscalation;
	kind: string;
	signal: MemoryConflictSignal;
	detail: string;
	/** How a pair of notes was found: shared words, or a local model's reading. */
	found_by?: "lexical" | "embeddings";
	textual: boolean;
	detected_at: string;
	a: MemoryConflictSide;
	b: MemoryConflictSide;
}

/** How a journal entry can be taken back: `undo` (automatic, last hour) or `unmerge`. */
export type MemoryRevertMode = "undo" | "unmerge";

/** The lifecycle's figures, read from the journal (`brain/lifecycle/metrics.py`). */
export interface MemoryLifecycleMetrics {
	restores_week: number;
	undone_week: number;
	automatic_forgets_week: number;
	live: number;
	pinned: number;
	pin_rate: number;
	conflicts_month: number;
	auto_settled_month: number;
	resolved_month: number;
	mean_resolution_hours: number | null;
	history_views: number;
	/** Canonical notes a person wrote in the last 30 days. */
	consensus_month?: number;
	/** Consensus notes still in the memory: neither forgotten nor replaced. */
	consensus_live?: number;
	/** Many restores this week: the automations remove too much. */
	too_aggressive: boolean;
}

export interface MemoryLifecycleView {
	journal: MemoryJournalEntry[];
	/** Entry id → how it can be taken back. */
	revertible: Record<string, MemoryRevertMode>;
	/** The newest automatic decision of the last hour still undoable. */
	lastUndo: string | null;
	metrics: MemoryLifecycleMetrics | null;
	/** Who settles an escalated pair; empty: anyone. */
	maintainers: string[];
	/** The lists of a module, a team or a branch: the most specific one covering a pair wins. */
	maintainerScopes: Record<string, string[]>;
	/** Whether the person at this machine may settle an escalated pair. */
	canArbitrate: boolean;
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

export interface MemoryRevertOutcome {
	mode: MemoryRevertMode;
	/** The notes brought back. */
	restored: string[];
	/** The pair queued again for a person, if any. */
	conflict: string | null;
}
