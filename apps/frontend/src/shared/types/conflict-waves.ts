/**
 * Execution waves across specs (Conflict Predictor, issue #358).
 *
 * The planner (`main/conflict-waves/planner.ts`) scores every pair of queued
 * specs from the files their plans declare and the files their worktrees
 * already changed, then groups them into waves of specs that can run side by
 * side. Purely static: no model is called, whatever the provider.
 */

import type { TaskStatus } from "./task";

/** How risky running two specs side by side is, from their shared files. */
export type WaveRiskLevel = "none" | "low" | "medium" | "high" | "critical";

/**
 * What to do with a spec that has no plan and no worktree yet: its footprint
 * is unknown. `isolate` (default) never runs it beside another spec;
 * `independent` assumes it touches nothing the others touch.
 */
export type UnplannedPolicy = "isolate" | "independent";

/** When the executor moves on to the next wave. */
export type WaveAdvanceWhen = "merged" | "review";

/** Knobs the renderer may set; everything else comes from the project. */
export interface ExecutionWaveOptions {
	/** Pairs whose score is at or below this run side by side (default 0). */
	tolerance?: number;
	unplannedPolicy?: UnplannedPolicy;
	/** Files outside its plan before a spec is reported as drifting (default 3). */
	driftThreshold?: number;
	/**
	 * Add fragile zones to the score: files the project's history changes
	 * together, one in each spec (default true).
	 */
	fragileZones?: boolean;
	/**
	 * Add code links to the score: imports of what the other spec edits,
	 * uses of what it removes (default true).
	 */
	codeLinks?: boolean;
}

/** What a test merge of two worktrees' commits said (`git merge-tree`). */
export type WaveMergeVerdict = "clean" | "conflict";

/** What the renderer sends: a project by id, tasks by id, never a path. */
export interface ExecutionWavePlanRequest {
	projectId: string;
	/** Tasks to plan; absent means every backlog / queue task of the project. */
	taskIds?: string[];
	options?: ExecutionWaveOptions;
}

export interface WavePlanTask {
	taskId: string;
	title: string;
	status: TaskStatus;
	/** Distinct files in its footprint (plan ∪ worktree changes). */
	fileCount: number;
	/** False when neither a plan nor a worktree says what it touches. */
	planned: boolean;
}

export interface WavePairRisk {
	a: string;
	b: string;
	score: number;
	level: WaveRiskLevel;
	/** Shared files, at most 20 (display paths). */
	sharedFiles: string[];
	/** True when one side has no known footprint (policy `isolate`). */
	unknown: boolean;
	/** True when the pair may not share a wave. */
	blocking: boolean;
	/**
	 * Set when the pair was test-merged: two specs of one wave, both with a
	 * worktree, sharing files under the tolerance. `conflict` splits them.
	 */
	mergeCheck?: WaveMergeVerdict;
	/** Files the test merge left in conflict, at most 20 (display paths). */
	conflictFiles?: string[];
	/**
	 * Fragile zones counted in the score: `a/x ↔ b/y`, a file of each spec
	 * that the history changes together; at most 20.
	 */
	fragileLinks?: string[];
	/**
	 * Code links counted in the score (#358, lot 3): `y → x`, a file of one
	 * spec importing a module the other edits; at most 20.
	 */
	importLinks?: string[];
	/** `y → symbol`: a file of one spec using what the other removes; at most 20. */
	symbolLinks?: string[];
}

/** Whether the history was read for fragile zones, and how far back. */
export interface WaveFragileZones {
	enabled: boolean;
	/** Commits read; null when off or when git could not read the history. */
	commits: number | null;
}

/** Whether the code was read for code links, and how much of it. */
export interface WaveCodeLinks {
	enabled: boolean;
	/** Files considered for reading across the plan. */
	files: number;
	/** True when a limit left files of a spec unread. */
	capped: boolean;
}

/** The preventive merge checks behind a plan; nothing is written to a worktree. */
export interface WaveMergeChecks {
	/** Pairs test-merged. */
	checked: number;
	/** Pairs the test merge put in different waves. */
	conflicts: number;
	/** Pairs that qualified but were left unchecked (pair or time limit reached). */
	unchecked: number;
	/** Pairs git could not test-merge (no common history, git too old). */
	failed: number;
}

export interface ExecutionWave {
	/** 1-based. */
	index: number;
	/** Specs of the wave, in the order to merge them. */
	taskIds: string[];
	/** Summed score of the pairs left inside the wave (under the tolerance). */
	residualRisk: number;
}

/** A spec whose worktree touched files its plan did not declare. */
export interface WaveDrift {
	taskId: string;
	extraCount: number;
	/** At most 20. */
	extraFiles: string[];
}

export interface WaveExclusion {
	taskId: string;
	/** In a dependency cycle, or waiting on a spec that is. */
	reason: "cycle" | "blocked_by_cycle";
}

/** A queued spec that shares files with a spec already running. */
export interface WaveRunningConflict {
	taskId: string;
	runningTaskId: string;
	score: number;
}

export interface ExecutionWavePlan {
	projectId: string;
	/** The project's "max parallel tasks" setting, the size limit of a wave. */
	maxParallel: number;
	tolerance: number;
	unplannedPolicy: UnplannedPolicy;
	waves: ExecutionWave[];
	/** Every planned spec, wave after wave, in merge order. */
	order: string[];
	tasks: WavePlanTask[];
	pairs: WavePairRisk[];
	/** Each dependency cycle found among the specs (`metadata.blockedBy`). */
	cycles: string[][];
	excluded: WaveExclusion[];
	drift: WaveDrift[];
	runningConflicts: WaveRunningConflict[];
	/** Summed score if every spec ran at once. */
	totalRisk: number;
	/** Summed score left inside the waves. */
	residualRisk: number;
	mergeChecks: WaveMergeChecks;
	fragileZones: WaveFragileZones;
	codeLinks: WaveCodeLinks;
	computedAt: string;
}

/**
 * An "Execute in optimal order" run, as the renderer saves it after every
 * step and the main process keeps in `<project>/.workpilot/` so that it
 * survives a restart. The waves already run are those before `current`.
 */
export interface WaveRunState {
	projectId: string;
	/** Task ids per wave, in merge order. */
	waves: string[][];
	/** 0-based index of the wave being run. */
	current: number;
	advanceWhen: WaveAdvanceWhen;
	/** The project's max parallel tasks, from the plan the run started from. */
	maxParallel: number;
	/** Tasks the run has already tried to start. */
	started: string[];
	/**
	 * What the plan the run started from avoided (#358, lot 3), for the run
	 * history: pairs split into different waves, and the risk taken out.
	 */
	avoided?: WaveRunAvoided;
}

export interface WaveRunAvoided {
	/** Pairs of specs that would have run side by side and were split. */
	conflicts: number;
	/** Total risk minus residual risk. */
	risk: number;
}

/** How a recorded run ended. */
export type WaveRunOutcome = "done" | "stopped";

/**
 * A run once it ended, kept in the project's run history (#358, lot 3) for
 * the sprint metrics: counted, never estimated.
 */
export interface WaveRunRecord {
	/** When the main process recorded the end. */
	finishedAt: string;
	outcome: WaveRunOutcome;
	waves: number;
	tasks: number;
	/** Tasks the run started. */
	started: number;
	conflictsAvoided: number;
	riskAvoided: number;
}

/**
 * A task's merge conflict, as the merge flow saw it (#358, lot 4): when a
 * merge or its preview reported it, and when the task's next merge
 * succeeded (null while it has not). Measured, never estimated.
 */
export interface MergeConflictTime {
	taskId: string;
	detectedAt: string;
	resolvedAt: string | null;
}

/** The project's merge conflicts, newest first; `ignored` when the file could not be read. */
export interface MergeConflictTimes {
	entries: MergeConflictTime[];
	ignored: boolean;
}

/** The project's run history, newest first; `ignored` when the file could not be read. */
export interface WaveRunHistory {
	records: WaveRunRecord[];
	ignored: boolean;
	/** When the residual merge conflicts appeared and were resolved. */
	conflicts?: MergeConflictTimes;
}

/** A run read back from the project: when it was saved, by the main process. */
export interface SavedWaveRun extends WaveRunState {
	savedAt: string;
}

/**
 * What a project holds: a run to resume or none; `ignored` when a saved file
 * was there but unreadable or incoherent (it is then left as it is).
 */
export interface SavedWaveRunResult {
	run: SavedWaveRun | null;
	ignored: boolean;
}
