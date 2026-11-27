/**
 * Raise and lift a task's « Bloquée » flag (`shared/utils/task-flag.ts`),
 * saved like any metadata edit (TASK_UPDATE; the card settings route in
 * server mode, `main/server-card-settings.ts`).
 */
import type { TaskMetadata } from "../../shared/types";
import { buildFlagMetadata, buildUnflagMetadata } from "../../shared/utils/task-flag";
import { useTaskStore } from "./task-store";

async function saveFlag(
	taskId: string,
	patch: Partial<TaskMetadata>,
): Promise<{ success: boolean; error?: string }> {
	const store = useTaskStore.getState();
	const task = store.tasks.find((t) => t.id === taskId || t.specId === taskId);
	try {
		const result = await globalThis.electronAPI.updateTask(taskId, { metadata: patch });
		if (!result.success) return { success: false, error: result.error };
		// A new updatedAt: the columns re-render a card only when it changes (tasksAreEquivalent).
		store.updateTask(taskId, {
			metadata: { ...(task?.metadata ?? {}), ...patch },
			updatedAt: new Date(),
		});
		return { success: true };
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function flagTask(taskId: string, reason?: string) {
	return saveFlag(taskId, buildFlagMetadata(reason));
}

export function unflagTask(taskId: string) {
	return saveFlag(taskId, buildUnflagMetadata());
}
