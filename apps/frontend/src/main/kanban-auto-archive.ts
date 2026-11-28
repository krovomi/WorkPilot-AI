/**
 * Archives the cards of local projects finished more than the chosen number
 * of days ago (`shared/utils/task-auto-archive.ts`), a while after the app
 * starts and then every hour. Server projects are the server's: never here.
 */
import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../shared/constants";
import type { Project, Task } from "../shared/types";
import { autoArchiveDays, autoArchiveIds } from "../shared/utils/task-auto-archive";
import { appLog } from "./app-logger";
import { safeSendToRenderer } from "./ipc-handlers/utils";
import { projectStore } from "./project-store";
import { readSettingsFile } from "./settings-utils";

const FIRST_LOOK_MS = 2 * 60_000;
const EVERY_MS = 60 * 60_000;

export interface AutoArchiveDeps {
	days: () => number;
	projects: () => Project[];
	tasks: (projectId: string) => Task[];
	archive: (projectId: string, taskIds: string[]) => boolean;
	reload: (projectId: string) => void;
	now: () => number;
}

/** One pass over the projects; returns how many cards it archived. */
export function archiveFinishedCards(deps: AutoArchiveDeps): number {
	const days = deps.days();
	if (days <= 0) return 0;
	let archived = 0;
	for (const project of deps.projects()) {
		if (!project.path || project.remote) continue;
		const ids = autoArchiveIds(deps.tasks(project.id), days, deps.now());
		if (ids.length === 0) continue;
		if (deps.archive(project.id, ids)) {
			archived += ids.length;
			deps.reload(project.id);
		} else {
			appLog.warn(`[AUTO-ARCHIVE] ${project.id}: some of ${ids.length} cards were not archived`);
		}
	}
	return archived;
}

let timer: ReturnType<typeof setInterval> | null = null;
let first: ReturnType<typeof setTimeout> | null = null;

export function startAutoArchive(getMainWindow: () => BrowserWindow | null): void {
	if (timer) return;
	const deps: AutoArchiveDeps = {
		days: () => autoArchiveDays(readSettingsFile()?.kanbanAutoArchiveDays),
		projects: () => projectStore.getProjects(),
		tasks: (projectId) => projectStore.getTasks(projectId),
		archive: (projectId, taskIds) => projectStore.archiveTasks(projectId, taskIds),
		// The board reloads its cards on this event, as after a merged PR (merged-watch.ts).
		reload: (projectId) => safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_SPLIT_EVENT, "", projectId, 0),
		now: () => Date.now(),
	};
	const look = () => {
		try {
			archiveFinishedCards(deps);
		} catch (error) {
			appLog.warn(`[AUTO-ARCHIVE] failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	first = setTimeout(look, FIRST_LOOK_MS);
	timer = setInterval(look, EVERY_MS);
	first.unref?.();
	timer.unref?.();
}

export function stopAutoArchive(): void {
	if (first) clearTimeout(first);
	if (timer) clearInterval(timer);
	first = null;
	timer = null;
}
