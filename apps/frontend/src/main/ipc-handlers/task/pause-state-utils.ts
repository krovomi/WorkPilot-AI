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

/** Spec directory copies that may hold a backend-visible pause flag. */
export function existingSpecDirs(dirs: (string | null | undefined)[]): string[] {
	const seen: string[] = [];
	for (const dir of dirs) {
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
		let previousPhase: string | null = null;
		if (existsSync(statePath)) {
			try {
				previousPhase =
					(JSON.parse(readFileSync(statePath, "utf-8")) as PauseStateRecord)
						.paused_phase ?? null;
			} catch {
				// Un fichier illisible se lit comme « pas de phase connue ».
			}
		}
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
		if (!existsSync(planFile)) continue;
		try {
			const plan = JSON.parse(readFileSync(planFile, "utf-8"));
			if (plan?.paused?.enabled) {
				plan.paused = { ...plan.paused, enabled: false };
				writeFileSync(planFile, JSON.stringify(plan, null, 2), "utf-8");
			}
		} catch (err) {
			appLog.warn(
				`[pause-state] Could not clear legacy pause flag in ${planFile}:`,
				err,
			);
		}
	}
}
