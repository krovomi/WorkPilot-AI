/**
 * Close the cards whose pull request was merged, and purge their worktree.
 *
 * Every few minutes, the PR of each local card waiting for review is read on
 * its forge (`pr-state.ts`). A merged one closes its card (`done`, with
 * `prMergedAt`); then every card whose PR is merged loses its worktree and
 * local branch (`purge.ts`), unless changes there are not committed. A PR
 * closed without a merge, or a forge that does not answer, changes nothing.
 * The parts of a split are followed by `split-merge-watch.ts`, which also
 * moves the parts stacked on them; their worktree is purged here once they
 * are done. A project under the strict offline mode is never looked at.
 */
import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../shared/constants";
import type { Project, Task } from "../../shared/types";
import { isServerTask, prUrlOf, splitPartOf } from "../../shared/utils/task-split";
import { appLog } from "../app-logger";
import { offlineStrict } from "../ipc-handlers/task/split-merge-watch";
import { writeMetadata } from "../ipc-handlers/task/stack-handlers";
import { safeSendToRenderer } from "../ipc-handlers/utils";
import { type PrState, readPrState } from "../pr-state";
import { projectStore } from "../project-store";
import { taskStateManager } from "../task-state-manager";
import { mergedSpecIds, type PurgeOutcome, purgeWorktrees } from "./purge";

const FIRST_LOOK_MS = 90_000;
const EVERY_MS = 5 * 60_000;

export interface MergedWatchDeps {
	readState: (url: string, project: Project) => Promise<PrState>;
	markDone: (task: Task, project: Project) => void;
	writeMetadata: (task: Task, project: Project, patch: Record<string, unknown>) => boolean;
	purge: (project: Project, tasks: readonly Task[], specIds: readonly string[]) => Promise<PurgeOutcome[]>;
	reload: (project: Project) => void;
	now?: () => Date;
}

/** Local cards, split parts aside, whose PR may have been merged since the last look. */
export function cardsAwaitingMerge(tasks: readonly Task[]): Task[] {
	return tasks.filter(
		(task) =>
			splitPartOf(task) === null &&
			!isServerTask(task) &&
			!task.metadata?.archivedAt &&
			!task.metadata?.prMergedAt &&
			(task.status === "pr_created" || task.status === "human_review") &&
			Boolean(prUrlOf(task)),
	);
}

/** One look at one project: cards closed, then merged worktrees purged. */
export async function followMergedPrs(
	project: Project,
	deps: MergedWatchDeps,
): Promise<{ closed: number; purged: number; freed: number }> {
	let closed = 0;
	for (const task of cardsAwaitingMerge(projectStore.getTasks(project.id))) {
		const url = prUrlOf(task);
		if (!url) continue;
		if ((await deps.readState(url, project)) !== "merged") continue;
		const at = (deps.now?.() ?? new Date()).toISOString();
		deps.writeMetadata(task, project, { prMergedAt: at });
		deps.markDone(task, project);
		appLog.info(`[MERGED] ${task.specId}: its PR was merged, the card is done`);
		closed += 1;
	}
	if (closed > 0) projectStore.invalidateTasksCache(project.id);

	const tasks = projectStore.getTasks(project.id);
	const outcomes = await deps.purge(project, tasks, mergedSpecIds(project, tasks));
	const purged = outcomes.filter((o) => o.purged);
	for (const o of outcomes) {
		if (o.error === "dirty") {
			appLog.info(`[MERGED] ${o.specId}: worktree kept, it has changes that are not committed`);
		}
	}
	const freed = purged.reduce((sum, o) => sum + o.bytes, 0);
	if (purged.length > 0) {
		appLog.info(`[MERGED] ${purged.length} merged worktree(s) purged, ${freed} bytes freed`);
	}
	if (closed > 0 || purged.length > 0) deps.reload(project);
	return { closed, purged: purged.length, freed };
}

let timer: ReturnType<typeof setInterval> | null = null;
let first: ReturnType<typeof setTimeout> | null = null;
let looking = false;

export function startMergedWatch(getMainWindow: () => BrowserWindow | null): void {
	if (timer) return;
	const deps: MergedWatchDeps = {
		readState: readPrState,
		markDone: (task, project) => {
			taskStateManager.handleManualStatusChange(task.id, "done", task, project);
		},
		writeMetadata,
		purge: (project, tasks, specIds) => purgeWorktrees(project, tasks, specIds),
		reload: (project) => {
			projectStore.invalidateTasksCache(project.id);
			safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_SPLIT_EVENT, "", project.id, 0);
		},
	};
	const look = async () => {
		if (looking) return;
		looking = true;
		try {
			for (const project of projectStore.getProjects()) {
				if (!project.path || project.remote || offlineStrict(project.path)) continue;
				await followMergedPrs(project, deps);
			}
		} catch (error) {
			appLog.warn(
				`[MERGED] Following the cards' PRs failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			looking = false;
		}
	};
	first = setTimeout(() => void look(), FIRST_LOOK_MS);
	timer = setInterval(() => void look(), EVERY_MS);
	first.unref?.();
	timer.unref?.();
}

export function stopMergedWatch(): void {
	if (first) clearTimeout(first);
	if (timer) clearInterval(timer);
	first = null;
	timer = null;
}
