import type { Task, TaskStatus } from "../../../shared/types";
import type { AgentManager } from "../../agent";
import { appLog } from "../../app-logger";
import { projectStore } from "../../project-store";
import {
	APP_SHUTDOWN_PAUSE_REASON,
	type PauseStateRecord,
	writePauseState,
} from "./pause-state-utils";
import {
	allSpecDirs,
	currentPausePhase,
	getSpecPaths,
	resumePausedTask,
} from "./resume-task";
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
 * Now closing is a pause, and opening is a resume. The pause is the same one
 * the Pause button writes (`pause_state.json`, every spec directory copy), with
 * `reason: "app_shutdown"` so the next launch can tell it from a pause the user
 * asked for — that one stays paused until the user says otherwise. The resume
 * is the Reprendre button's own path (`resumePausedTask`), so the backend
 * re-enters the phase from the spec directory, reopens the subtask the dead
 * process was on, and replays the interrupted transcript: the conversation log
 * for every provider, the SDK's own session for Claude when it still has it.
 */

/** Persisted statuses in which a task has an agent process behind it. */
const RUNNING_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
	"in_progress",
	"ai_review",
]);

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
			`[interrupted-runs] ${paused.length} running task(s) will resume on next launch: ${paused.join(", ")}`,
		);
	}
	return paused;
}

/**
 * Whether this task was running when the application last stopped.
 *
 * Two ways to know. A clean close left the shutdown pause above. A crash, a
 * forced kill or an OS shutdown that never delivered `before-quit` left
 * nothing but the status: a task persisted as running, at launch, when this
 * process has started nothing — so no process is behind it. A pause the user
 * asked for is neither, and stays paused.
 */
export function wasInterruptedByAppExit(
	task: Task,
	isRunning: (taskId: string) => boolean,
): boolean {
	if (task.metadata?.archivedAt || task.metadata?.abandoned) return false;
	if (isRunning(task.id)) return false;
	const paused = task.metadata?.paused;
	if (paused?.enabled) return paused.reason === APP_SHUTDOWN_PAUSE_REASON;
	return RUNNING_STATUSES.has(task.status);
}

/**
 * Resume, at launch, every task the application was running when it stopped.
 *
 * Called once, after the profile manager is up and the window has loaded, so
 * the resumed runs' events have somewhere to go. A task that cannot be resumed
 * (spec directory gone, provider not configured any more) keeps its pause and
 * its Reprendre button: failing to restart it on its own is not a reason to
 * lose where it had stopped.
 */
export async function resumeTasksInterruptedByAppExit(
	agentManager: AgentManager,
): Promise<string[]> {
	const resumed: string[] = [];
	for (const project of projectStore.getProjects()) {
		let tasks: Task[];
		try {
			projectStore.invalidateTasksCache(project.id);
			tasks = projectStore.getTasks(project.id);
		} catch (err) {
			appLog.warn(
				`[interrupted-runs] Could not read tasks of ${project.id}:`,
				err,
			);
			continue;
		}
		for (const task of tasks) {
			if (!wasInterruptedByAppExit(task, (id) => agentManager.isRunning(id))) {
				continue;
			}
			try {
				const result = await resumePausedTask(agentManager, task.id, project.id);
				if (result.success) {
					resumed.push(task.id);
				} else {
					appLog.warn(
						`[interrupted-runs] Task ${task.id} not resumed: ${result.error}`,
					);
				}
			} catch (err) {
				appLog.warn(`[interrupted-runs] Task ${task.id} not resumed:`, err);
			}
		}
	}
	if (resumed.length > 0) {
		appLog.info(
			`[interrupted-runs] Resumed ${resumed.length} task(s) interrupted by the last exit: ${resumed.join(", ")}`,
		);
	}
	return resumed;
}
