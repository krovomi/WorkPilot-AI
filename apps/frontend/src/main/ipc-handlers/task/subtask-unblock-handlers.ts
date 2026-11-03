/**
 * Answer a blocked subtask from its panel: it is done, it is not needed, try
 * again, or try again with this reply.
 *
 * The answer is applied to every copy of the task's plan (the one the panel
 * shows first, then the main project's and the worktree's: the main one is
 * authoritative when the build restarts). A retry or a reply restarts the
 * build through the same path as the Start button, so the coder picks the
 * subtask back up with the reply in its prompt, on the task's own engine.
 * A server card is answered by the server (`unblockServerSubtask`).
 *
 * Arguments come from the renderer and are checked again here (rule S6).
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult } from "../../../shared/types";
import {
	MAX_REPLY,
	RESTART_ACTIONS,
	UNBLOCK_ACTIONS,
	type UnblockAction,
	UnblockRefused,
	applyUnblock,
} from "../../../shared/utils/subtask-unblock";
import { appLog } from "../../app-logger";
import { projectStore } from "../../project-store";
import { findServerCard } from "../../server-board-actions";
import { unblockServerSubtask } from "../../server-board-review";
import { getTaskControl } from "./execution-handlers";
import {
	type ExecutionHandlerContext,
	atomicWriteFileSync,
	getPlanPaths,
	safeReadFileSync,
} from "./execution-utils";
import { getSpecPaths } from "./resume-task";
import { findTaskAndProject } from "./shared";

/** A subtask id as planners write them (`subtask-1-2`, `change-request-…`). */
const SUBTASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TASK_ID_MAX = 300;

type UnblockResult = IPCResult<{ restarted: boolean }>;

function refused(code: string): UnblockResult {
	return { success: false, error: code };
}

/** Apply the answer to one plan file; the updated plan's JSON, or a refusal code. */
function applyToPlan(
	planPath: string,
	subtaskId: string,
	action: UnblockAction,
	reply: string | undefined,
	now: string,
): string {
	const content = safeReadFileSync(planPath);
	if (!content) throw new UnblockRefused("plan_unreadable");
	let plan: Record<string, unknown>;
	try {
		plan = JSON.parse(content);
	} catch {
		throw new UnblockRefused("plan_unreadable");
	}
	if (!plan || typeof plan !== "object") {
		throw new UnblockRefused("plan_unreadable");
	}
	applyUnblock(plan, subtaskId, action, reply, now);
	return JSON.stringify(plan, null, 2);
}

export async function unblockSubtask(
	isRunning: (taskId: string) => boolean,
	taskId: unknown,
	subtaskId: unknown,
	action: unknown,
	reply: unknown,
): Promise<UnblockResult> {
	if (typeof taskId !== "string" || !taskId || taskId.length > TASK_ID_MAX) {
		return refused("task_not_found");
	}
	if (typeof subtaskId !== "string" || !SUBTASK_ID.test(subtaskId)) {
		return refused("subtask_not_found");
	}
	if (
		typeof action !== "string" ||
		!(UNBLOCK_ACTIONS as readonly string[]).includes(action)
	) {
		return refused("invalid_action");
	}
	if (reply !== undefined && reply !== null && typeof reply !== "string") {
		return refused("invalid_action");
	}
	const said = typeof reply === "string" ? reply : undefined;
	if (said && said.trim().length > MAX_REPLY) return refused("reply_too_long");
	const answer = action as UnblockAction;
	const restart = RESTART_ACTIONS.has(answer);

	const serverCard = findServerCard(taskId);
	if (serverCard) {
		return unblockServerSubtask(serverCard, subtaskId, answer, said);
	}

	const { task, project } = findTaskAndProject(taskId);
	if (!task || !project) return refused("task_not_found");
	if (restart && isRunning(taskId)) return refused("task_running");

	const planPaths = getPlanPaths(getSpecPaths(task, project), project);
	const now = new Date().toISOString();
	// The plan the panel shows decides; the other copies follow it, and may
	// not hold the subtask (a worktree made before it was added).
	try {
		atomicWriteFileSync(
			planPaths.primary,
			applyToPlan(planPaths.primary, subtaskId, answer, said, now),
		);
	} catch (error) {
		if (error instanceof UnblockRefused) return refused(error.code);
		appLog.error("[UNBLOCK_SUBTASK] Could not write the plan:", error);
		return refused("plan_unreadable");
	}
	for (const copy of planPaths.all) {
		if (copy === planPaths.primary) continue;
		try {
			atomicWriteFileSync(copy, applyToPlan(copy, subtaskId, answer, said, now));
		} catch (error) {
			appLog.warn(
				`[UNBLOCK_SUBTASK] Plan copy left as it was (${copy}): ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	projectStore.invalidateTasksCache(project.id);
	appLog.info(`[UNBLOCK_SUBTASK] ${taskId} ${subtaskId}: ${answer}`);

	if (!restart) return { success: true, data: { restarted: false } };
	const control = getTaskControl();
	const restarted = control ? await control.start(taskId) : false;
	return { success: true, data: { restarted } };
}

export function registerSubtaskUnblockHandlers(ctx: ExecutionHandlerContext): void {
	ipcMain.handle(
		IPC_CHANNELS.TASK_UNBLOCK_SUBTASK,
		(_, taskId: unknown, subtaskId: unknown, action: unknown, reply: unknown) =>
			unblockSubtask(
				(id) => ctx.agentManager.isRunning(id),
				taskId,
				subtaskId,
				action,
				reply,
			),
	);
}
