import { useMemo } from "react";
import type { TaskStatusColumn } from "../../shared/constants";
import type { Task } from "../../shared/types";
import { useKanbanSettingsStore } from "../stores/kanban-settings-store";
import { useTaskStore } from "../stores/task-store";

/**
 * Whether the « Build rouge » column has a reason to be on the board: a task
 * sits in it, or a CI pipeline reports runs for one of the board's tasks.
 */
export function shouldShowBuildFailedColumn(
	tasks: readonly Task[],
	pipelineStatuses: Readonly<Record<string, { state: string } | undefined>>,
): boolean {
	return tasks.some(
		(task) =>
			task.status === "build_failed" ||
			(pipelineStatuses[task.id]?.state ?? "none") !== "none",
	);
}

/**
 * The user's column order, minus « Build rouge » on a project without CI.
 *
 * That column only fills when a CI pipeline (Azure DevOps, GitHub Actions,
 * GitLab CI, Jenkins) goes red on a task's branch. Without a pipeline it stays
 * empty forever and only takes room, so it appears with the first run.
 */
export function useVisibleKanbanColumns(
	tasks: readonly Task[],
): TaskStatusColumn[] {
	const columnOrder = useKanbanSettingsStore((state) => state.columnOrder);
	const showBuildFailed = useTaskStore((state) =>
		shouldShowBuildFailedColumn(tasks, state.pipelineStatuses),
	);
	return useMemo(
		() =>
			showBuildFailed
				? columnOrder
				: columnOrder.filter((status) => status !== "build_failed"),
		[columnOrder, showBuildFailed],
	);
}
