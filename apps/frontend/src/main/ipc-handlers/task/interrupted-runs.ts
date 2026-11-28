import type { AgentManager } from "../../agent";
import { appLog } from "../../app-logger";
import {
	APP_SHUTDOWN_PAUSE_REASON,
	type PauseStateRecord,
	writePauseState,
} from "./pause-state-utils";
import { allSpecDirs, currentPausePhase, getSpecPaths } from "./resume-task";
import { findTaskAndProject } from "./shared";

/**
 * The builds WorkPilot was running when it was closed, and picking them back up.
 *
 * Closing the application used to kill every agent subprocess and leave the
 * card exactly where it was: `in_progress`, with nothing running behind it.
 * The next launch showed it "stuck" a minute later, and the only way out was
 * the stuck-task recovery, which reset the subtask in progress to `pending`,
 * deleted what it had recorded and restarted without the interrupted session —
 * the phase started over, on every provider.
 *
 * Now closing is a pause. The pause is the same one the Pause button writes
 * (`pause_state.json`, every spec directory copy), with `reason:
 * "app_shutdown"` so the next launch can tell it from a pause the user asked
 * for — that one stays paused until the user says otherwise. What the next
 * launch does with it (ask, resume, or leave it) is `interrupted-prompt.ts`;
 * every resume is the Reprendre button's own path (`resumePausedTask`), so the
 * backend re-enters the phase from the spec directory, reopens the subtask the
 * dead process was on, and replays the interrupted transcript: the
 * conversation log for every provider, the SDK's own session for Claude when
 * it still has it.
 */

/**
 * Record, for every build still running, that the application is closing.
 *
 * Synchronous on purpose: it runs from `before-quit`, before the processes are
 * killed, and nothing after the kill may be relied on to happen. Killing is
 * left to `killAll`, which waits for the processes to exit; the kill marks each
 * spawn as killed, so no exit transition is emitted and the card keeps its
 * column. Returns the ids of the tasks that will be resumed on the next launch.
 */
export function pauseRunningTasksForShutdown(
	agentManager: AgentManager,
): string[] {
	const paused: string[] = [];
	for (const taskId of agentManager.getRunningTasks()) {
		try {
			const { task, project } = findTaskAndProject(taskId);
			// Ideation, roadmap and the other runners are not Kanban tasks: they
			// have no spec directory to resume from, and are simply stopped.
			if (!task || !project) continue;
			if (task.metadata?.paused?.enabled) continue; // the user's own pause stands

			const specPaths = getSpecPaths(task, project);
			const specDirs = allSpecDirs(specPaths);
			if (specDirs.length === 0) continue;

			const state: PauseStateRecord = {
				enabled: true,
				paused_at: new Date().toISOString(),
				paused_phase: currentPausePhase(task, specPaths),
				paused_subtask_id: task.executionProgress?.currentSubtask ?? null,
				provider: task.metadata?.provider ?? null,
				model: task.metadata?.model ?? null,
				reason: APP_SHUTDOWN_PAUSE_REASON,
			};
			if (writePauseState(specDirs, state) > 0) {
				paused.push(taskId);
			}
		} catch (err) {
			// Quitting must never be blocked by one task's bookkeeping.
			appLog.warn(`[interrupted-runs] Could not record ${taskId}:`, err);
		}
	}
	if (paused.length > 0) {
		appLog.info(
			`[interrupted-runs] ${paused.length} running task(s) paused for the next launch: ${paused.join(", ")}`,
		);
	}
	return paused;
}
