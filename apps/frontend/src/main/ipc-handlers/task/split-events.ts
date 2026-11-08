/**
 * Tell the board that a task became its parts (`TASK_SPLIT`, `task_split`).
 *
 * The backend has written the parts and closed the task (archived, plan
 * settled `done`) before it emits the event. The renderer gets the task's new
 * metadata first, so the card leaves the board and its "done" is not
 * announced as a finished build, then a reload of the board for the parts,
 * which go to the queue.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { Project, Task, TaskMetadata } from "../../../shared/types";
import { appLog } from "../../app-logger";
import { projectStore } from "../../project-store";
import { safeSendToRenderer } from "../utils";
import { getSpecPaths } from "./resume-task";

function readMetadata(task: Task, project: Project): TaskMetadata | null {
	const { mainSpecDir, worktreeSpecDir } = getSpecPaths(task, project);
	for (const dir of [mainSpecDir, worktreeSpecDir]) {
		if (!dir) continue;
		const file = path.join(dir, "task_metadata.json");
		if (!existsSync(file)) continue;
		try {
			const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as TaskMetadata;
			}
		} catch {
			// The next copy may be readable.
		}
	}
	return null;
}

/** The number of parts, as the event says it; 0 when it says nothing usable. */
export function splitTotal(event: { total?: unknown }): number {
	const total = event.total;
	return typeof total === "number" && Number.isInteger(total) && total > 0
		? total
		: 0;
}

export function announceSplit(
	getMainWindow: () => BrowserWindow | null,
	task: Task,
	project: Project,
	event: { total?: unknown },
): void {
	projectStore.invalidateTasksCache(project.id);
	const metadata = readMetadata(task, project);
	if (metadata?.splitGroup) {
		safeSendToRenderer(
			getMainWindow,
			IPC_CHANNELS.TASK_UPDATED_EVENT,
			task.id,
			{
				metadata: {
					splitGroup: metadata.splitGroup,
					archivedAt: metadata.archivedAt,
				},
			},
			project.id,
		);
	}
	const total = splitTotal(event);
	appLog.info(`[SPLIT] ${task.specId} became ${total} tasks`);
	safeSendToRenderer(
		getMainWindow,
		IPC_CHANNELS.TASK_SPLIT_EVENT,
		task.id,
		project.id,
		total,
	);
}
