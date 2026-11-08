/**
 * Start a part of a split task on top of the part it waits for.
 *
 * The parts of a split (`apps/backend/task_split/`) that depend on one
 * another form a chain: part 2 needs part 1's code. The board lets part 2
 * start once part 1 passed QA (`canStartOnSibling`), long before part 1 is
 * merged; started from the trunk, part 2 would be built without the code it
 * needs. So at its start, and only then (before its worktree exists), it is
 * stacked on part 1 (F6, `stackOn`): its worktree starts from part 1's
 * branch, its PR targets it, and "Mettre à jour" keeps it there.
 *
 * A part whose blocker is merged (`done`) starts from the trunk like any
 * task, and so does a server card (stacking runs git on this computer).
 */

import type { Project, Task } from "../../../shared/types";
import { isServerTask, splitPartOf } from "../../../shared/utils/task-split";
import { appLog } from "../../app-logger";
import { projectStore } from "../../project-store";
import { findTaskWorktree } from "../../worktree-paths";
import { stackOn } from "./stack-handlers";

export type SplitStackResult =
	| { ok: true; stackedOn?: string }
	| { ok: false; error: string };

function sameTask(task: Task, id: string): boolean {
	return task.id === id || task.specId === id;
}

/** The part `task` waits for, when it is a part of the same split not merged yet. */
export function unmergedSiblingBlocker(
	task: Task,
	tasks: readonly Task[],
): Task | undefined {
	const part = splitPartOf(task);
	if (!part) return undefined;
	for (const id of task.metadata?.blockedBy ?? []) {
		const blocker = tasks.find((t) => sameTask(t, id));
		if (!blocker || splitPartOf(blocker)?.parent !== part.parent) continue;
		if (blocker.status === "done" || blocker.metadata?.archivedAt) continue;
		if (blocker.metadata?.abandoned) continue;
		return blocker;
	}
	return undefined;
}

/**
 * Stack `task` on its unmerged sibling before it starts; `task.metadata` is
 * updated in place, so the start that follows reads the new base branch.
 */
export async function stackSplitPartBeforeStart(
	task: Task,
	project: Project,
): Promise<SplitStackResult> {
	if (!splitPartOf(task) || isServerTask(task)) return { ok: true };
	if (task.metadata?.stackParent) return { ok: true };
	if (project.path && findTaskWorktree(project.path, task.specId)) {
		return { ok: true }; // already started: its base is moved by "update"
	}
	const sibling = unmergedSiblingBlocker(task, projectStore.getTasks(project.id));
	if (!sibling) return { ok: true };
	const result = await stackOn(task.id, sibling.id);
	if (!result.success || !result.data) {
		appLog.warn(
			`[SPLIT] ${task.specId} cannot start on ${sibling.specId}: ${result.error ?? "unknown"}`,
		);
		return { ok: false, error: result.error ?? "stack_failed" };
	}
	task.metadata = { ...(task.metadata ?? {}), ...result.data };
	appLog.info(`[SPLIT] ${task.specId} starts stacked on ${sibling.specId}`);
	return { ok: true, stackedOn: sibling.specId };
}

/** The sentence the card shows when a part cannot start on its sibling. */
export function splitStackError(task: Task, code: string): string {
	const part = splitPartOf(task);
	const which = part ? `part ${part.index}/${part.total}` : task.specId;
	return `Could not start ${which} on the part it builds on (${code}). Merge or update that part, then start this one again.`;
}
