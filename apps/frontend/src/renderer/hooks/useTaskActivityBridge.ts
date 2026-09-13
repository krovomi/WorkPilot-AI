import type { Task, TaskStatus } from "@shared/types/task";
import { useEffect } from "react";
import {
	dropActivity,
	finishActivity,
	startActivity,
} from "../stores/activity-store";
import { useTaskStore } from "../stores/task-store";

/** Where a build stops being work in progress and becomes a result. */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
	"human_review",
	"done",
	"pr_created",
	"error",
]);

function isRunning(task: Task): boolean {
	// A paused task is still `in_progress`, but nothing is running — the same
	// distinction the navigation guard in App.tsx makes.
	return task.status === "in_progress" && !task.metadata?.paused?.enabled;
}

function isFailure(task: Task): boolean {
	// A failed build reaches the board as human_review with reviewReason
	// "errors", which is the status a successful one gets too. Read the reason,
	// not the column.
	return task.status === "error" || task.reviewReason === "errors";
}

/**
 * Mirrors the Kanban's own task list into the activity registry, so the menu
 * entry can say what the board would say if the user were looking at it.
 *
 * Derived from the task list rather than from status-change events on purpose:
 * events only describe transitions, so a reload while agents are running would
 * leave the sidebar silent about work that is very much in progress.
 */
export function useTaskActivityBridge(): void {
	useEffect(() => {
		const tracked = new Set<string>();

		const reconcile = (tasks: Task[]) => {
			const seen = new Set<string>();

			for (const task of tasks) {
				const id = `task:${task.id}`;
				seen.add(id);

				if (isRunning(task)) {
					if (!tracked.has(id)) {
						tracked.add(id);
						startActivity({
							id,
							view: "kanban",
							projectId: task.projectId,
							labelKey: "navigation:activity.kinds.build",
							label: task.title,
						});
					}
					continue;
				}

				if (!tracked.has(id)) continue;
				tracked.delete(id);

				if (TERMINAL_STATUSES.has(task.status)) {
					finishActivity(
						id,
						isFailure(task) ? "error" : "success",
						task.errorMessage?.trim().split("\n")[0],
					);
				} else {
					// Paused, or dragged back to an earlier column: the work stopped
					// without producing a result, and a badge would claim otherwise.
					dropActivity(id);
				}
			}

			for (const id of [...tracked]) {
				if (seen.has(id)) continue;
				tracked.delete(id);
				dropActivity(id);
			}
		};

		reconcile(useTaskStore.getState().tasks);

		return useTaskStore.subscribe((state, previous) => {
			if (state.tasks !== previous.tasks) reconcile(state.tasks);
		});
	}, []);
}
