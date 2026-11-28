/**
 * "How you compare" in Build Analytics: a project's specs against its own
 * past and against other projects, on figures that mean the same on every
 * stack and every provider (`apps/backend/shared_features/build_compare.py`).
 *
 * On this computer the other projects are the person's own; in server mode
 * they are the organization's projects the person may read, and the server
 * sends their medians only, never their names.
 */

export const COMPARE_METRICS = [
	"minutes",
	"cost",
	"qa_iterations",
	"agents",
	"mutation_score",
	"ci_first_pass",
] as const;

export type CompareMetric = (typeof COMPARE_METRICS)[number];

/**
 * The figures for which more is better, both in percent: the mutation score
 * of a spec's QA, and the share of specs whose PR passed CI as it was opened.
 */
export const HIGHER_IS_BETTER: ReadonlySet<CompareMetric> = new Set(["mutation_score", "ci_first_pass"]);

/** A metric's median, or null when no spec recorded it. */
export type CompareMedians = Record<CompareMetric, number | null>;

/** A project's medians over the specs started in a window of days. */
export interface CompareWindow extends CompareMedians {
	specs: number;
}

/** Projects of the same segment, stack, team size, or all of them. */
export interface CompareGroup {
	projects: number;
	/** Null below `min_group` projects: a median never stands for one project. */
	medians: CompareMedians | null;
	/** The figure the best tenth reach, from `min_top` projects; null below. */
	top: CompareMedians | null;
	/**
	 * Percent change of its medians from the window before to the last, from
	 * `min_group` projects in both; null below, and for a kind's group.
	 */
	trend: CompareMedians | null;
}

export const COMPARE_GROUPS = ["segment", "stack", "team", "all"] as const;

export type CompareGroupName = (typeof COMPARE_GROUPS)[number];

/** The project's specs of one kind (bug fix, feature…) against that kind elsewhere. */
export interface CompareKindLine extends CompareWindow {
	kind: string;
	group: CompareGroup;
}

/** One of the person's own projects (this computer only). */
export interface CompareProjectLine extends CompareWindow {
	name: string;
	stack: string;
	size: string;
	team: string;
	current: boolean;
}

export interface BuildComparison {
	window_days: number;
	min_group: number;
	/** The fewest projects a top tenth is given for; null when none is. */
	min_top: number | null;
	/**
	 * `size_from` / `team_from`: the bucket the project left during the last
	 * window; while it moves it is compared with both. Null when it did not.
	 */
	segment: { stack: string; size: string; team: string; size_from: string | null; team_from: string | null };
	recent: CompareWindow;
	previous: CompareWindow;
	/** Percent change from the previous window to the last. */
	trend: CompareMedians;
	/** The project's own medians week by week, the oldest first. */
	weeks: CompareWindow[];
	groups: Record<CompareGroupName, CompareGroup>;
	/** The most built kind first. */
	kinds: CompareKindLine[];
	/** Empty in server mode. */
	projects: CompareProjectLine[];
}

/** The comparison worded in the app's language, for the team report (PDF). */
export interface CompareReportDocument {
	title: string;
	summary: string[];
	tables: { title: string; columns: string[]; rows: string[][] }[];
}
