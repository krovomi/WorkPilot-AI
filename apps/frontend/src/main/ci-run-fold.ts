/**
 * Several pipeline runs of one commit read as one verdict: a commit's suite
 * is red when any of its runs failed or was cancelled, still pending while
 * one is queued or running, green only when all of them succeeded.
 */

import type { PipelineRunState } from "../shared/types";

/** The fields of a run this fold reads (`PipelineRun` of the adapters). */
interface FoldableRun {
	state: PipelineRunState;
}

/** A commit's runs as one: failed if one failed, running while one runs. */
export function foldRuns<Run extends FoldableRun>(runs: Run[]): Run | null {
	if (runs.length === 0) return null;
	const pick = (state: PipelineRunState) =>
		runs.find((run) => run.state === state);
	const failed = pick("failed") ?? pick("canceled");
	if (failed) return failed;
	const pending = pick("running") ?? pick("queued");
	if (pending) return pending;
	return pick("partiallySucceeded") ?? runs[0];
}
