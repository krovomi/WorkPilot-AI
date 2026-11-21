import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult, StopAfterStepResult } from "../../../shared/types";
import type { AgentManager } from "../../agent";
import { appLog } from "../../app-logger";
import { VOICE_STOP_PAUSE_REASON } from "./pause-state-utils";
import { pauseTaskNow } from "./pause-task";
import { findTaskAndProject } from "./shared";

/**
 * The spoken « stop » of the voice assistant (issue #385): every running task
 * stops after the step it is in, not in the middle of it.
 *
 * Each task gets the pause the Pause button writes (`pause_state.json` in every
 * spec copy, `reason: "voice_stop"`), but its process is left running: the
 * backend reads that file after each tool result and ends the session there
 * (`agents/tool_breaker.py`), so the tool call in flight finishes and the next
 * one never starts, whatever the provider. Its loop then stops at the pause and
 * the card resumes from its phase when the person chooses.
 *
 * Agent processes that are not tasks (ideation, roadmap…) have no step to stop
 * after and are left alone: « Stop all agents » is the button for those. Takes
 * no argument from the renderer: what runs is read here.
 */
export function stopAgentsAfterStep(agentManager: AgentManager): StopAfterStepResult {
	const result: StopAfterStepResult = { stoppingTasks: [], failedTasks: [] };
	for (const id of agentManager.getRunningTasks()) {
		const { task } = findTaskAndProject(id);
		if (!task || task.metadata?.paused?.enabled) continue;
		let paused = false;
		try {
			paused = pauseTaskNow(agentManager, id, {
				reason: VOICE_STOP_PAUSE_REASON,
				halt: false,
			}).success;
		} catch (error) {
			appLog.warn(`[AGENTS_STOP_AFTER_STEP] Could not pause ${id}:`, error);
		}
		(paused ? result.stoppingTasks : result.failedTasks).push(id);
	}
	appLog.info(
		`[AGENTS_STOP_AFTER_STEP] ${result.stoppingTasks.length} task(s) stop after their current step, ` +
			`${result.failedTasks.length} could not be asked to.`,
	);
	return result;
}

export function registerStopAfterStepHandlers(agentManager: AgentManager): void {
	ipcMain.handle(
		IPC_CHANNELS.AGENTS_STOP_AFTER_STEP,
		async (): Promise<IPCResult<StopAfterStepResult>> => ({
			success: true,
			data: stopAgentsAfterStep(agentManager),
		}),
	);
}
