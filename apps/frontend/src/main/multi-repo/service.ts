/**
 * The multi-repo runs of this app instance: at most one per orchestration.
 */
import { type MultiRepoHost, MultiRepoRun } from "./run";

const runs = new Map<string, MultiRepoRun>();

export function isMultiRepoRunning(dir: string): boolean {
	return runs.get(dir)?.running ?? false;
}

/** Starts (or resumes) the orchestration in `dir`; `false` if it already runs. */
export function startMultiRepoRun(dir: string, host: MultiRepoHost): boolean {
	if (isMultiRepoRunning(dir)) return false;
	const run = new MultiRepoRun(dir, host);
	runs.set(dir, run);
	void run.run().finally(() => {
		if (runs.get(dir) === run) runs.delete(dir);
	});
	return true;
}

/** Stops the orchestration in `dir`; `false` if it was not running. */
export function stopMultiRepoRun(dir: string): boolean {
	const run = runs.get(dir);
	if (!run?.running) return false;
	run.stop();
	return true;
}
