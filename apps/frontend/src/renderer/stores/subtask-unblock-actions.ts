/**
 * The subtask panel's answers to a blocked subtask, sent to the main process
 * (`TASK_UNBLOCK_SUBTASK`). On success the subtask is redrawn at once with
 * its new state; the plan file the main process wrote is read again by the
 * board's next refresh.
 */

import type { Subtask } from "../../shared/types";
import type { UnblockAction } from "../../shared/utils/subtask-unblock";
import { useTaskStore } from "./task-store";

export interface UnblockOutcome {
	success: boolean;
	restarted?: boolean;
	/** A refusal code (`tasks:subtasks.unblock.errors.<code>`) or a message. */
	error?: string;
}

/** The subtask as the panel shows it right after the answer. */
export function unblockedSubtask(
	subtask: Subtask,
	action: UnblockAction,
	reply?: string,
	now: string = new Date().toISOString(),
): Subtask {
	const {
		blockedReason,
		blockedKind: _kind,
		humanResolution: _previous,
		...rest
	} = subtask;
	if (action === "complete" || action === "skip") {
		return {
			...rest,
			status: "completed",
			humanResolution: {
				action,
				at: now,
				...(blockedReason ? { reason: blockedReason } : {}),
			},
		};
	}
	return {
		...rest,
		status: "pending",
		...(action === "answer" && reply?.trim() ? { humanReply: reply.trim() } : {}),
	};
}

export async function unblockSubtask(
	taskId: string,
	subtaskId: string,
	action: UnblockAction,
	reply?: string,
): Promise<UnblockOutcome> {
	try {
		const result = await globalThis.electronAPI.unblockSubtask(
			taskId,
			subtaskId,
			action,
			reply,
		);
		if (!result.success) return { success: false, error: result.error };
		const store = useTaskStore.getState();
		const task = store.tasks.find((t) => t.id === taskId);
		if (task) {
			store.updateTask(taskId, {
				subtasks: task.subtasks.map((s) =>
					s.id === subtaskId ? unblockedSubtask(s, action, reply) : s,
				),
			});
		}
		return { success: true, restarted: result.data?.restarted ?? false };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
