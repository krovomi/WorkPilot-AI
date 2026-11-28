/**
 * Each task's captures summary on the task itself, for the board
 * (`Task.captures`): the card's camera badge and its hover preview read it
 * without one call per card. Called by `project-store.ts` beside the run
 * facts; files are read once per change (mtime cache in `read-captures.ts`).
 */

import path from "node:path";
import { getSpecsDir } from "../../shared/constants";
import type { Task } from "../../shared/types";
import { findTaskWorktree } from "../worktree-paths";
import { capturesSpecDir, hasCaptures, readCapturesSummary } from "./read-captures";

export interface CapturesLocation {
	path: string;
	autoBuildPath?: string | null;
}

/**
 * The folders that may hold a task's captures: the project's spec folder,
 * then (on this computer) the spec folder inside the task's workspace.
 */
export function captureSpecCandidates(
	project: CapturesLocation,
	specId: string,
	local = true,
): string[] {
	const specs = getSpecsDir(project.autoBuildPath || undefined);
	const candidates = [path.join(project.path, specs, specId)];
	if (local) {
		const worktree = findTaskWorktree(project.path, specId);
		if (worktree) candidates.push(path.join(worktree, specs, specId));
	}
	return candidates;
}

/** The spec folder whose publication is the newest, if any. */
export function taskCapturesDir(
	project: CapturesLocation,
	specId: string,
	local = true,
): string | undefined {
	return capturesSpecDir(captureSpecCandidates(project, specId, local));
}

export function attachCaptures(
	project: CapturesLocation,
	tasks: Task[],
	local: boolean,
): Task[] {
	return tasks.map((task) => {
		if (!task.specId) return task;
		try {
			const dir = taskCapturesDir(project, task.specId, local);
			const captures = dir ? readCapturesSummary(dir) : undefined;
			return captures ? { ...task, captures } : task;
		} catch (error) {
			console.warn("[task-captures] not read:", error);
			return task;
		}
	});
}

/**
 * The task has screens for its PR: the visual proof then stays on this
 * computer (no commit on the task's branch, no PR comment of its own).
 */
export function taskHasCaptures(project: CapturesLocation, specId: string): boolean {
	try {
		const dir = taskCapturesDir(project, specId, true);
		return hasCaptures(dir ? readCapturesSummary(dir) : undefined);
	} catch {
		return false;
	}
}
