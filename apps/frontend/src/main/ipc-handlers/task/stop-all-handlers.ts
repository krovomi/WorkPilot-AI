import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult, StopAllResult } from "../../../shared/types";
import type { AgentManager } from "../../agent";
import { appLog } from "../../app-logger";
import { KILL_SWITCH_PAUSE_REASON } from "./pause-state-utils";
import { pauseTaskNow } from "./pause-task";
import { findTaskAndProject } from "./shared";
import { registerStopAfterStepHandlers } from "./stop-after-step-handlers";

/**
 * "Stop all agents": the kill switch (issue #353).
 *
 * Every task with an agent behind it is paused the way the Pause button pauses
 * it (`pause_state.json` in every spec copy, then its process halted), with
 * `reason: "kill_switch"`: nothing is lost, each card says why it stopped, and
 * each one resumes from its phase when the person chooses. Unlike the pause
 * written when the app closes, the next launch does not resume these.
 *
 * Every other agent process (ideation, roadmap, insights…) has no spec to
 * resume from and is stopped outright. A task whose pause cannot be written
 * is stopped all the same: stopping is the point of the switch.
 *
 * Takes no argument from the renderer: what runs is read here.
 */
export function stopAllAgents(agentManager: AgentManager): StopAllResult {
	const result: StopAllResult = { pausedTasks: [], stoppedProcesses: 0, failedTasks: [] };
	for (const id of agentManager.getRunningTasks()) {
		const { task } = findTaskAndProject(id);
		if (!task) {
			if (agentManager.haltTask(id)) result.stoppedProcesses += 1;
			continue;
		}
		if (task.metadata?.paused?.enabled && !agentManager.isRunning(id)) continue;
		let paused = false;
		try {
			paused = pauseTaskNow(agentManager, id, { reason: KILL_SWITCH_PAUSE_REASON }).success;
		} catch (error) {
			appLog.warn(`[AGENTS_STOP_ALL] Could not pause ${id}:`, error);
		}
		if (paused) {
			result.pausedTasks.push(id);
		} else {
			agentManager.haltTask(id);
			result.failedTasks.push(id);
		}
	}
	appLog.info(
		`[AGENTS_STOP_ALL] ${result.pausedTasks.length} task(s) paused, ` +
			`${result.stoppedProcesses} other agent process(es) stopped, ` +
			`${result.failedTasks.length} stopped without a pause record.`,
	);
	return result;
}

/** Both ways to stop the agents: at once (the kill switch), or after their step (the spoken stop). */
export function registerStopAllHandlers(agentManager: AgentManager): void {
	registerStopAfterStepHandlers(agentManager);
	ipcMain.handle(
		IPC_CHANNELS.AGENTS_STOP_ALL,
		async (): Promise<IPCResult<StopAllResult>> => ({
			success: true,
			data: stopAllAgents(agentManager),
		}),
	);
}
