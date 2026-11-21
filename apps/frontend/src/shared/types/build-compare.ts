/**
 * "How you compare" in Build Analytics: a project's specs against its own
 * past and against other projects, on figures that mean the same on every
 * stack and every provider (`apps/backend/shared_features/build_compare.py`).
 *
 * On this computer the other projects are the person's own; in server mode
 * they are the organization's projects the person may read, and the server
 * sends their medians only, never their names.
 */

export const COMPARE_METRICS = ["minutes", "cost", "qa_iterations", "agents"] as const;

export type CompareMetric = (typeof COMPARE_METRICS)[number];

/** A metric's median, or null when no spec recorded it. */
export type CompareMedians = Record<CompareMetric, number | null>;

/** A project's medians over the specs started in a window of days. */
export interface CompareWindow extends CompareMedians {
	specs: number;
}

/** Projects of the same segment, stack, or all of them. */
export interface CompareGroup {
	projects: number;
	/** Null below `min_group` projects: a median never stands for one project. */
	medians: CompareMedians | null;
}

/** One of the person's own projects (this computer only). */
export interface CompareProjectLine extends CompareWindow {
	name: string;
	stack: string;
	size: string;
	current: boolean;
}

export interface BuildComparison {
	window_days: number;
	min_group: number;
	segment: { stack: string; size: string };
	recent: CompareWindow;
	previous: CompareWindow;
	/** Percent change from the previous window to the last. */
	trend: CompareMedians;
	groups: { segment: CompareGroup; stack: CompareGroup; all: CompareGroup };
	/** Empty in server mode. */
	projects: CompareProjectLine[];
}
