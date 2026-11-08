/**
 * Follow the parts of a split once their PRs are open (`task_split`).
 *
 * Every few minutes, the PR of each local part waiting for review is read on
 * its forge (`pr-state.ts`). A merged one closes its part (`done`, with
 * `prMergedAt`), and the parts stacked on it move onto its base: a rebase
 * `--onto` the base, which survives a squash merge, and their PR retargeted
 * (`stackUpdate`, F6). The board is then reloaded and the queue started, so a
 * part that waited for that merge starts. A PR closed without a merge, a
 * forge that does not answer, a stacked part with an agent running, local
 * edits or a conflict: nothing is done, and the next look tries again (a
 * conflict is not retried until the part moves). The person resolves a
 * conflict from the card's stack panel, as for any stacked task. A project
 * under the strict offline mode (`.workpilot/offline-mode.json`) is never
 * looked at: its forge is network too.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { Project, Task } from "../../../shared/types";
import {
	partsAwaitingMerge,
	partsToMoveOntoBase,
	prUrlOf,
} from "../../../shared/utils/task-split";
import type { AgentManager } from "../../agent";
import { appLog } from "../../app-logger";
import { type PrState, readPrState } from "../../pr-state";
import { projectStore } from "../../project-store";
import { taskStateManager } from "../../task-state-manager";
import { safeSendToRenderer } from "../utils";
import { stackUpdate, writeMetadata } from "./stack-handlers";

const FIRST_LOOK_MS = 60_000;
const EVERY_MS = 3 * 60_000;

export interface SplitMergeDeps {
	readState: (url: string, project: Project) => Promise<PrState>;
	markDone: (task: Task, project: Project) => void;
	writeMetadata: (task: Task, project: Project, patch: Record<string, unknown>) => boolean;
	moveOntoBase: (taskId: string) => Promise<{ success: boolean; error?: string }>;
	reload: (project: Project) => void;
	now?: () => Date;
}

/** Stacked parts whose last move stopped on a conflict, by task and commit. */
const conflicted = new Set<string>();

function conflictKey(task: Task): string {
	return `${task.id}@${task.metadata?.stackParentSha ?? ""}`;
}

/** Strict offline mode, or a policy that cannot be read: no network for this project. */
export function offlineStrict(projectPath: string): boolean {
	const file = path.join(projectPath, ".workpilot", "offline-mode.json");
	if (!existsSync(file)) return false;
	try {
		const policy = JSON.parse(readFileSync(file, "utf-8")) as { airgapStrict?: unknown };
		return policy?.airgapStrict !== false && policy?.airgapStrict !== undefined;
	} catch {
		return true;
	}
}

/** One look at one project; the number of parts merged or moved. */
export async function followSplitParts(project: Project, deps: SplitMergeDeps): Promise<number> {
	let changed = 0;
	for (const part of partsAwaitingMerge(projectStore.getTasks(project.id))) {
		const url = prUrlOf(part);
		if (!url) continue;
		const state = await deps.readState(url, project);
		if (state !== "merged") continue;
		const at = (deps.now?.() ?? new Date()).toISOString();
		deps.writeMetadata(part, project, { prMergedAt: at });
		deps.markDone(part, project);
		appLog.info(`[SPLIT] ${part.specId}: its PR was merged, the part is done`);
		changed += 1;
	}
	if (changed > 0) projectStore.invalidateTasksCache(project.id);

	for (const part of partsToMoveOntoBase(projectStore.getTasks(project.id))) {
		const key = conflictKey(part);
		if (conflicted.has(key)) continue;
		const result = await deps.moveOntoBase(part.id);
		if (result.success) {
			appLog.info(`[SPLIT] ${part.specId} moved onto the merged part's base`);
			changed += 1;
		} else if (result.error === "conflict") {
			conflicted.add(key);
			appLog.warn(`[SPLIT] ${part.specId}: moving onto the base stopped on a conflict`);
		}
	}
	if (changed > 0) deps.reload(project);
	return changed;
}

let timer: ReturnType<typeof setInterval> | null = null;
let first: ReturnType<typeof setTimeout> | null = null;
let looking = false;

export function startSplitMergeWatch(
	agentManager: AgentManager,
	getMainWindow: () => BrowserWindow | null,
): void {
	if (timer) return;
	const deps: SplitMergeDeps = {
		readState: readPrState,
		markDone: (task, project) => {
			taskStateManager.handleManualStatusChange(task.id, "done", task, project);
		},
		writeMetadata,
		moveOntoBase: (taskId) => stackUpdate(taskId, agentManager),
		reload: (project) => {
			projectStore.invalidateTasksCache(project.id);
			// The board reloads and the queue starts what no longer waits.
			safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_SPLIT_EVENT, "", project.id, 0);
		},
	};
	const look = async () => {
		if (looking) return;
		looking = true;
		try {
			for (const project of projectStore.getProjects()) {
				if (!project.path || offlineStrict(project.path)) continue;
				await followSplitParts(project, deps);
			}
		} catch (error) {
			appLog.warn(
				`[SPLIT] Following the parts' PRs failed: ${error instanceof Error ? error.message : String(error)}`,
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

export function stopSplitMergeWatch(): void {
	if (first) clearTimeout(first);
	if (timer) clearInterval(timer);
	first = null;
	timer = null;
}
