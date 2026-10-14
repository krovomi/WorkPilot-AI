/**
 * Context-window management IPC: the manual "compact now" / "new thread"
 * command, and the live edit of a task's `contextPolicy`.
 *
 * Kept out of execution-handlers.ts on purpose (that file is already ~3 000
 * lines). The telemetry itself (CONTEXT_USAGE / CONTEXT_ACTION_APPLIED) is
 * forwarded by agent-events-handlers.ts on TASK_CONTEXT_USAGE.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult } from "../../../shared/types";
import type { ContextAction } from "../../../shared/types/context-usage";
import type { ContextPolicy } from "../../../shared/types/task";
import {
	isContextAction,
	normalizeContextPolicy,
} from "../../../shared/utils/context-policy";
import type { AgentManager } from "../../agent";
import { appLog } from "../../app-logger";
import {
	mergeContextPolicyIntoSpecDirs,
	writeContextActionMarker,
} from "./context-files";
import { allSpecDirs, getSpecPaths } from "./resume-task";
import { findTaskAndProject } from "./shared";

export function registerTaskContextHandlers(agentManager: AgentManager): void {
	/**
	 * One-shot compact / clear. The process keeps running; the backend picks
	 * the marker up at its next safe point and answers with
	 * CONTEXT_ACTION_APPLIED.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_CONTEXT_ACTION,
		async (_, taskId: string, action: ContextAction): Promise<IPCResult> => {
			if (!isContextAction(action)) {
				return { success: false, error: `Invalid context action: ${String(action)}` };
			}
			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}
			// A marker left behind for a stopped task would fire on the next
			// run's first safe point, on a session nobody asked to compact.
			if (!agentManager.isRunning(task.id)) {
				return { success: false, error: "Task is not running" };
			}
			try {
				const specDirs = allSpecDirs(getSpecPaths(task, project));
				const outcome = writeContextActionMarker(specDirs, action);
				for (const { dir, error } of outcome.failed) {
					appLog.warn(`[TASK_CONTEXT_ACTION] Could not write marker in ${dir}:`, error);
				}
				if (outcome.written.length === 0) {
					return { success: false, error: "Could not write context action marker" };
				}
				appLog.info(
					`[TASK_CONTEXT_ACTION] task=${taskId} action=${action} dirs=${outcome.written.length}`,
				);
				return { success: true };
			} catch (err) {
				appLog.error(`[TASK_CONTEXT_ACTION] Failed for task ${taskId}:`, err);
				return {
					success: false,
					error: err instanceof Error ? err.message : "Context action failed",
				};
			}
		},
	);

	/**
	 * Live policy edit. TASK_UPDATE only rewrites the main copy of
	 * task_metadata.json; the running backend reads the worktree one, so this
	 * handler merges `contextPolicy` into every copy, and updates the cached
	 * task so the next getTasks reflects it.
	 */
	ipcMain.handle(
		IPC_CHANNELS.TASK_CONTEXT_POLICY_UPDATE,
		async (
			_,
			taskId: string,
			policy: Partial<ContextPolicy>,
		): Promise<IPCResult<{ contextPolicy: ContextPolicy }>> => {
			const { task, project } = findTaskAndProject(taskId);
			if (!task || !project) {
				return { success: false, error: "Task not found" };
			}
			const contextPolicy = normalizeContextPolicy({
				...task.metadata?.contextPolicy,
				...policy,
			});
			try {
				const specDirs = allSpecDirs(getSpecPaths(task, project));
				const outcome = mergeContextPolicyIntoSpecDirs(specDirs, contextPolicy);
				for (const { dir, error } of outcome.failed) {
					appLog.warn(`[TASK_CONTEXT_POLICY_UPDATE] Could not update ${dir}:`, error);
				}
				if (outcome.written.length === 0) {
					return { success: false, error: "Could not write task metadata" };
				}
				task.metadata = { ...task.metadata, contextPolicy };
				appLog.info(
					`[TASK_CONTEXT_POLICY_UPDATE] task=${taskId} mode=${contextPolicy.mode} ` +
						`threshold=${contextPolicy.thresholdPct} handoff=${contextPolicy.prepareHandoff} ` +
						`dirs=${outcome.written.length}`,
				);
				return { success: true, data: { contextPolicy } };
			} catch (err) {
				appLog.error(`[TASK_CONTEXT_POLICY_UPDATE] Failed for task ${taskId}:`, err);
				return {
					success: false,
					error: err instanceof Error ? err.message : "Context policy update failed",
				};
			}
		},
	);
}
