import type { IPCResult } from "../../../shared/types";
import type { AgentManager } from "../../agent";
import { projectStore } from "../../project-store";
import { type PauseStateRecord, writePauseState } from "./pause-state-utils";
import { allSpecDirs, currentPausePhase, getSpecPaths } from "./resume-task";
import { findTaskAndProject } from "./shared";

export interface PausedTask {
	taskId: string;
	paused: true;
	pausedAt: string;
	pausedPhase: string;
	specDirs: number;
	wasRunning: boolean;
}

/**
 * Pause a task now, at whatever phase it is in: the Pause button, and every
 * task "Stop all agents" stops (`reason: "kill_switch"`).
 *
 * The flag goes to `pause_state.json`, not into `implementation_plan.json`:
 * that file does not exist during spec creation or planning. The backend reads
 * the same file from its coder loop, its QA loop and its spec pipeline, so one
 * pause stops all three, and Resume picks the phase up where it stopped.
 */
export function pauseTaskNow(
	agentManager: AgentManager,
	taskId: string,
	options: { subtaskId?: string; reason?: string } = {},
): IPCResult<PausedTask> {
	const { task, project } = findTaskAndProject(taskId);
	if (!task || !project) {
		return { success: false, error: "Task not found" };
	}

	const specPaths = getSpecPaths(task, project);
	const specDirs = allSpecDirs(specPaths);
	if (specDirs.length === 0) {
		return { success: false, error: "Spec directory not found" };
	}

	const phase = currentPausePhase(task, specPaths);
	const pausedState: PauseStateRecord = {
		enabled: true,
		paused_at: new Date().toISOString(),
		paused_phase: phase,
		paused_subtask_id: options.subtaskId ?? task.executionProgress?.currentSubtask ?? null,
		provider: task.metadata?.provider ?? null,
		model: task.metadata?.model ?? null,
		...(options.reason ? { reason: options.reason } : {}),
	};

	const written = writePauseState(specDirs, pausedState);
	if (written === 0) {
		return { success: false, error: "Could not write pause state" };
	}

	// Re-scan so the scanner surfaces the pause on task.metadata; the
	// UI uses that to switch the controls into the paused state.
	projectStore.invalidateTasksCache(project.id);

	// Immediate pause: stop the running subprocess NOW rather than waiting for
	// the backend to reach its next cooperative checkpoint (which, mid-session,
	// can be a long way off). haltTask marks the spawn as killed (its exit
	// handler returns early WITHOUT emitting "exit" — no PROCESS_EXITED /
	// USER_STOPPED, so the card keeps its current column) AND unregisters the
	// task from the OperationRegistry so the proactive profile-swap / usage
	// monitor cannot resurrect the paused process when a token limit is hit.
	const wasRunning = agentManager.haltTask(taskId);

	return {
		success: true,
		data: {
			taskId,
			paused: true,
			pausedAt: pausedState.paused_at ?? "",
			pausedPhase: phase,
			specDirs: written,
			wasRunning,
		},
	};
}
