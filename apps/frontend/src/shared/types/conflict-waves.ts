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
}

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
	computedAt: string;
}
