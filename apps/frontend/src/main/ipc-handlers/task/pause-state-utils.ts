import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AUTO_BUILD_PATHS } from "../../../shared/constants";
import { appLog } from "../../app-logger";

/**
 * The cooperative pause, written where the backend reads it.
 *
 * `pause_state.json` lives in the spec directory — which exists from the moment
 * the task does, unlike `implementation_plan.json`, whose absence during
 * planning is why a pause used to be impossible there. The backend's coder
 * loop, QA loop and spec pipeline all read this one file (`core/pause_state.py`),
 * so one write reaches every phase.
 *
 * Every caller that resumes a build goes through `clearPauseState`. Four of them
 * used to clear `plan.paused` by hand, each with a slightly different shape; one
 * missed copy means the restarted backend re-pauses at its first checkpoint and
 * the resume looks like it silently did nothing.
 */

export interface PauseStateRecord {
	enabled: boolean;
	paused_at: string | null;
	paused_phase?: string | null;
	paused_subtask_id: string | null;
	provider?: string | null;
	model?: string | null;
}

/**
 * Read and parse a JSON file, or `null` when it is not there or not readable.
 *
 * Deliberately no `existsSync` first: between the check and the read the file
 * can be created, replaced or removed — the worktree these paths point into is
 * written by a live agent subprocess — so the guard buys nothing and opens a
 * race. The read itself is the check.
 */
function readJson<T>(filePath: string): T | null {
	try {
		return JSON.parse(readFileSync(filePath, "utf-8")) as T;
	} catch {
		return null;
	}
}

/** Spec directory copies that may hold a backend-visible pause flag. */
export function existingSpecDirs(dirs: (string | null | undefined)[]): string[] {
	const seen: string[] = [];
	for (const dir of dirs) {
		// A directory test, not a check-then-read of a file's contents: it keeps
		// a removed worktree's spec directory from being recreated by the write
		// that follows. The writes themselves tolerate a directory that vanishes
		// in between.
		if (!dir || seen.includes(dir) || !existsSync(dir)) continue;
		seen.push(dir);
	}
	return seen;
}

export function writePauseState(
	specDirs: string[],
	state: PauseStateRecord,
): number {
	let written = 0;
	for (const specDir of specDirs) {
		try {
			writeFileSync(
				path.join(specDir, AUTO_BUILD_PATHS.PAUSE_STATE),
				JSON.stringify(state, null, 2),
				"utf-8",
			);
			written++;
		} catch (err) {
			appLog.warn(`[pause-state] Could not write pause state in ${specDir}:`, err);
		}
	}
	return written;
}

/**
 * Lift the pause before restarting a build.
 *
 * `planPaths` clears the pre-`pause_state.json` flag as well: a task paused by
 * an older version is still read as paused through the backend's compatibility
 * path, so leaving it set would re-pause the build the user just resumed.
 */
export function clearPauseState(
	specDirs: string[],
	planPaths: string[],
	overrides: { provider?: string | null; model?: string | null } = {},
): void {
	for (const specDir of specDirs) {
		const statePath = path.join(specDir, AUTO_BUILD_PATHS.PAUSE_STATE);
		// An absent or unreadable file reads as "no phase recorded" — the same
		// answer the backend's own reader would give.
		const previousPhase =
			readJson<PauseStateRecord>(statePath)?.paused_phase ?? null;
		writePauseState([specDir], {
			enabled: false,
			paused_at: null,
			// Kept so the UI can still say where the build had stopped until the
			// next event overwrites it; losing it on resume loses the trace.
			paused_phase: previousPhase,
			paused_subtask_id: null,
			provider: overrides.provider ?? null,
			model: overrides.model ?? null,
		});
	}

	for (const planFile of planPaths) {
		const plan = readJson<{ paused?: { enabled?: boolean } }>(planFile);
		if (!plan?.paused?.enabled) continue;
		try {
			plan.paused = { ...plan.paused, enabled: false };
			writeFileSync(planFile, JSON.stringify(plan, null, 2), "utf-8");
		} catch (err) {
			appLog.warn(
				`[pause-state] Could not clear legacy pause flag in ${planFile}:`,
				err,
			);
		}
	}
}
