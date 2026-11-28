/**
 * Execution waves of a server project (Conflict Predictor, #358), as the
 * desktop shows them in server mode. The server plans the backlog from its
 * clone and runs "Execute in optimal order" itself
 * (`apps/backend/shared_features/execution_waves.py`); the main process
 * rebuilds each answer field by field (`main/conflict-waves/server-waves.ts`)
 * and the renderer only ever sees these shapes. Counted or measured by the
 * server, never estimated.
 */

import type { ExecutionWave, WaveAdvanceWhen, WaveExclusion, WaveRunOutcome } from "./conflict-waves";
import type { TaskStatus } from "./task";

/** Why the server's run did not start a card (a closed list the server keeps). */
export type ServerWaveStartFailure =
	| "needs_approval"
	| "claimed"
	| "already_running"
	| "quota"
	| "refused"
	| "missing";

export interface ServerWavePlanTask {
	taskId: string;
	title: string;
	/** False when neither a plan nor a worktree says what it touches. */
	planned: boolean;
	fileCount: number;
}

/** `GET /api/features/execution-waves/plan`: the waves of the backlog, as the server plans them now. */
export interface ServerWavePlan {
	/** The size limit of a wave, after the organisation's quota. */
	maxParallel: number;
	waves: ExecutionWave[];
	tasks: ServerWavePlanTask[];
	excluded: WaveExclusion[];
	/** Dependency cycles found among the cards. */
	cycles: number;
	totalRisk: number;
	residualRisk: number;
	mergeChecks: { checked: number; conflicts: number };
}

/** The run of "Execute in optimal order", as the server keeps it in its clone. */
export interface ServerWaveRun {
	waves: string[][];
	/** 0-based index of the wave being run. */
	current: number;
	advanceWhen: WaveAdvanceWhen;
	maxParallel: number;
	started: string[];
	failures: Record<string, ServerWaveStartFailure>;
	savedAt: string | null;
}

/** A card of the run, with its column on the server's board. */
export interface ServerWaveCard {
	id: string;
	title: string;
	/** Null when the card is no longer on the board. */
	column: TaskStatus | null;
	running: boolean;
}

/** `GET`, `POST .../run`, `POST .../run/step`, `DELETE .../run`. */
export interface ServerWaveRunAnswer {
	run: ServerWaveRun | null;
	cards: ServerWaveCard[];
	/** Cards waiting for a card they depend on. */
	blocked: string[];
	ended: WaveRunOutcome | null;
	/** True when the saved run could not be read and was set aside. */
	ignored: boolean;
}

/** `GET .../history`: the last days of runs, counted, and of merge conflicts, timed. */
export interface ServerWaveHistory {
	ignored: boolean;
	summary: {
		days: number;
		runs: number;
		stopped: number;
		conflictsAvoided: number;
		riskAvoided: number;
		started: number;
		lastFinishedAt: string | null;
	};
	conflicts: {
		ignored: boolean;
		resolved: number;
		/** Median time from the conflict to the merge, measured; null when none was resolved. */
		medianSeconds: number | null;
		open: number;
	};
}
