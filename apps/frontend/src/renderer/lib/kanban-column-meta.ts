/**
 * What a Kanban column shows about itself in its header band (« Bandeau »
 * style, docs/architecture/kanban-columns.md): its accent and how full it is.
 *
 * The accents repeat the `.column-*` rules of styles/globals.css, which stay
 * the source the cards' rail reads; `kanban-column-meta.test.ts` keeps the
 * two in step. They are needed here to compute, per theme, text colours that
 * stay readable on the band (lib/kanban-column-tokens.ts).
 */
import type { TaskStatusColumn } from "../../shared/constants/task";

/** A theme token (`--info`) or a fixed colour, as `.column-*` sets it. */
export type ColumnAccent = { token: string } | { color: string };

export const COLUMN_ACCENTS: Record<TaskStatusColumn, ColumnAccent> = {
	backlog: { token: "--muted-foreground" },
	queue: { color: "#22d3ee" },
	in_progress: { token: "--info" },
	ai_review: { token: "--warning" },
	human_review: { color: "#A855F7" },
	failed: { color: "#F97316" },
	build_failed: { token: "--destructive" },
	pr_created: { color: "#818CF8" },
	done: { token: "--success" },
	abandoned: { color: "#94A3B8" },
};

/**
 * `slots`: the parallel tasks of « En cours », a hard limit (full = amber).
 * `wip`: a soft limit set by the user on a column (amber once exceeded).
 */
export type ColumnCapacityKind = "slots" | "wip";
export type ColumnCapacityState = "open" | "full" | "over";

export interface ColumnCapacity {
	kind: ColumnCapacityKind;
	limit: number;
	state: ColumnCapacityState;
	/** Share of the limit in use, 0 to 100, for the gauge. */
	fill: number;
	/** Whether the count must read as a warning. */
	warn: boolean;
}

/** Above this many slots the gauge is a bar, not one segment per slot. */
export const MAX_GAUGE_SEGMENTS = 8;

export function columnCapacity(
	count: number,
	limit: number | undefined,
	kind: ColumnCapacityKind,
): ColumnCapacity | null {
	if (!limit || limit < 1) return null;
	let state: ColumnCapacityState = "open";
	if (count > limit) state = "over";
	else if (count === limit) state = "full";
	return {
		kind,
		limit,
		state,
		fill: Math.min(100, Math.round((count / limit) * 100)),
		warn: kind === "slots" ? state !== "open" : state === "over",
	};
}
