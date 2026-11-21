/**
 * The recorded test run where it was proposed, and the recording replayed
 * without a window (reshoot) (#387).
 *
 * - `runRecordedTest`: the last test proposed on a review card for the
 *   project (`lastReviewedTest`), run in that card's worktree by
 *   `browser_recorder_runner.py run`, after the worktree's recipe. The runner
 *   has the static environment (no provider, key or Claude profile, S1), so a
 *   test that reads secrets from the environment is not run: the person runs
 *   it with them set.
 * - `reshootRecording`: the steps the main kept for the stopped recording,
 *   replayed by `browser_recorder_runner.py reshoot`; for a step only a later
 *   selector still finds, the runner proposes new selectors, kept here until
 *   the person applies them (`applyReshoot`, by step id).
 *
 * The renderer only names the project and step ids; the worktree, the file and
 * the steps are the main's own.
 */
import {
	type RecorderRunOutcome,
	type ReshootOutcome,
	type ReshootStep,
	parseReshoot,
	parseTestRun,
} from "../../shared/types/browser-recorder-run";
import type { RecordedSelector, RecorderEvent } from "../../shared/types/browser-recorder";
import { decodeRunnerError } from "../utils/runner-error";
import { lastReviewedTest } from "./recorder-export";
import {
	broadcastRecorderEvent,
	ERROR_PREFIX,
	readLines,
	type SpawnRunner,
	sessionSteps,
	spawnRecorderRunner,
	updateStepSelectors,
} from "./recorder-session";

export const RUN_PREFIX = "RECORDER_RUN:";
export const RESHOOT_PREFIX = "RECORDER_RESHOOT:";

export interface RunDeps {
	readonly spawnRunner: SpawnRunner;
	readonly broadcast: (event: RecorderEvent) => void;
}

/** The selectors each reshoot proposed, by project, then by step id. */
const proposals = new Map<string, Map<string, readonly RecordedSelector[]>>();

/** Runs the runner with `args` (and `input` on stdin); its line starting with `prefix`, parsed. */
export async function runnerResult(
	spawnRunner: SpawnRunner,
	args: string[],
	prefix: string,
	input = "",
): Promise<unknown> {
	const child = await spawnRunner(args);
	return new Promise((resolve, reject) => {
		let result: string | null = null;
		let error: string | null = null;
		readLines(child, (line) => {
			if (line.startsWith(prefix)) result = line.slice(prefix.length);
			else if (line.startsWith(ERROR_PREFIX)) error = decodeRunnerError(line.slice(ERROR_PREFIX.length));
		});
		child.on("error", reject);
		child.on("close", (code) => {
			try {
				if (code === 0 && result !== null) {
					resolve(JSON.parse(result));
					return;
				}
			} catch {
				// Not JSON: reported below.
			}
			reject(new Error(error ?? `The recorder runner exited with code ${code}`));
		});
		child.stdin?.end(input);
	});
}

function failure(error: unknown): { success: false; error: string } {
	return { success: false, error: error instanceof Error ? error.message : String(error) };
}

export async function runRecordedTest(projectPath: string, deps: RunDeps): Promise<RecorderRunOutcome> {
	const test = lastReviewedTest(projectPath);
	if (!test) return { success: false, error: "Propose the test on a review card first, then run it there." };
	if (test.envVars.length) {
		return {
			success: false,
			error: `This test reads ${test.envVars.join(", ")} from the environment: run it yourself with them set.`,
		};
	}
	try {
		const raw = await runnerResult(
			deps.spawnRunner,
			[
				"run",
				`--project=${projectPath}`,
				`--root=${test.root}`,
				`--file=${test.path}`,
				`--format=${test.format}`,
				`--spec=${test.specId}`,
			],
			RUN_PREFIX,
		);
		const run = parseTestRun(raw);
		return run ? { success: true, run } : { success: false, error: "The test run gave no result." };
	} catch (error) {
		return failure(error);
	}
}

export async function reshootRecording(projectPath: string, deps: RunDeps): Promise<ReshootOutcome> {
	const steps = sessionSteps(projectPath);
	if (!steps.length) return { success: false, error: "Stop a recording first: its steps are replayed." };
	try {
		const raw = await runnerResult(
			deps.spawnRunner,
			["reshoot", `--project=${projectPath}`],
			RESHOOT_PREFIX,
			JSON.stringify({ steps }),
		);
		const known = new Set(steps.map((step) => step.id));
		const shots: ReshootStep[] = parseReshoot(raw).filter((shot) => known.has(shot.id));
		proposals.set(
			projectPath,
			new Map(shots.flatMap((shot) => (shot.selectors ? [[shot.id, shot.selectors] as const] : []))),
		);
		return { success: true, steps: shots };
	} catch (error) {
		return failure(error);
	}
}

/** Gives the steps named the selectors the last reshoot proposed for them; how many changed. */
export function applyReshoot(projectPath: string, ids: readonly string[], deps: RunDeps): { success: boolean; applied: number } {
	const proposed = proposals.get(projectPath) ?? new Map<string, readonly RecordedSelector[]>();
	let applied = 0;
	for (const id of ids) {
		const selectors = proposed.get(id);
		const step = selectors ? updateStepSelectors(projectPath, id, selectors) : null;
		if (!step) continue;
		proposed.delete(id);
		deps.broadcast({ type: "step", step });
		applied += 1;
	}
	return { success: applied > 0, applied };
}

export const defaultRunDeps: RunDeps = {
	spawnRunner: spawnRecorderRunner,
	broadcast: broadcastRecorderEvent,
};

/** For tests: forget the proposals. */
export function resetRecorderRunForTests(): void {
	proposals.clear();
}
