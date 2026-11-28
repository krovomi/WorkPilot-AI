/**
 * Drops that touch the outcome columns (« Échec », « Abandonnée »), handled
 * before the board's status moves (KanbanBoard `handleDragEnd`):
 *
 * - « Échec » is filled by the runs alone: a drop there is refused;
 * - a drop on « Abandonnée » asks why (AbandonRequestDialog), for the dragged
 *   task or the whole selection;
 * - a task dragged out of « Abandonnée » is resumed, then moved by the usual
 *   rules when it lands in another column than its status.
 *
 * Design: docs/architecture/kanban-columns.md.
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { TASK_STATUS_COLUMNS, type TaskStatusColumn } from "../../shared/constants/task";
import type { Task } from "../../shared/types";
import { canMoveTaskTo, getBoardColumn, getVisualColumn } from "../lib/kanban-columns";
import { useAbandonRequestStore } from "../stores/abandon-request-store";
import { resumeAbandonedTask, useTaskStore } from "../stores/task-store";
import { toast } from "./use-toast";

const COLUMNS = new Set<string>(TASK_STATUS_COLUMNS);

/** The column a drop lands in: the column itself, or the column of the task under it. */
export function dropColumnOf(overId: string, tasks: readonly Task[]): TaskStatusColumn | null {
	if (COLUMNS.has(overId)) return overId as TaskStatusColumn;
	const over = tasks.find((task) => task.id === overId);
	return over ? getBoardColumn(over) : null;
}

/**
 * Returns a handler that says whether it took care of the drop (true: the
 * board stops there).
 */
export function useOutcomeDrop(selection: readonly Task[]) {
	const { t } = useTranslation(["tasks"]);
	return useCallback(
		async (task: Task, overId: string): Promise<boolean> => {
			const target = dropColumnOf(overId, useTaskStore.getState().tasks);
			if (!target || target === getBoardColumn(task)) return false;
			const inSelection = selection.length > 1 && selection.some((s) => s.id === task.id);
			const group = inSelection ? selection : [task];
			if (target === "failed") {
				toast({ title: t("tasks:kanban.outcome.failedDropRefused") });
				return true;
			}
			if (target === "abandoned") {
				const ids = group.filter((g) => canMoveTaskTo(g, "abandoned")).map((g) => g.id);
				if (ids.length > 0) useAbandonRequestStore.getState().request(ids);
				else toast({ title: t("tasks:kanban.outcome.doneCannotBeAbandoned") });
				return true;
			}
			// A selection is resumed card by card on its way (useBoardBulkEdits).
			if (inSelection || task.metadata?.abandoned !== true) return false;
			const resumed = await resumeAbandonedTask(task.id);
			if (!resumed.success) {
				toast({
					title: t("tasks:abandon.resumeFailedTitle"),
					description: resumed.error || t("tasks:abandon.resumeFailedDescription"),
					variant: "destructive",
				});
				return true;
			}
			// Back in its own status column: nothing more to move.
			return target === getVisualColumn(task.status);
		},
		[selection, t],
	);
}
