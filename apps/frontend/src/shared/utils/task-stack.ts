/**
 * Stacking a task on another one (killer feature F6): the rules, without I/O.
 *
 * A task B stacked on A starts from A's branch instead of the trunk, so B's
 * code builds on A's before A is merged. Only a blocker of B can be its
 * parent (B already waits for A), never in a loop, and only before B's
 * worktree exists: once B has started, its base is moved by "update", not by
 * stacking again. The main process checks the rest (A has a worktree and a
 * commit) and runs git (`main/ipc-handlers/task/stack-handlers.ts`); the PR
 * side is `apps/backend/core/stacked_pr.py`.
 */

import type { Task } from "../types";

export const STACK_BRANCH_PREFIX = "workpilot/";
/** A full commit hash, as `git rev-parse` prints it. */
export const COMMIT_SHA = /^[0-9a-f]{40}$/;
/** A spec folder name, as WorkPilot writes them (`001-add-login`). */
export const SPEC_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,200}$/;
/** A branch name `git` and `gh` may receive (`foundation/base_branch.py`). */
const BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;

export type StackRefusal =
	| "same_task"
	| "not_blocker"
	| "cycle"
	| "already_stacked"
	| "parent_done";

export interface StackStatus {
	stacked: boolean;
	parentTaskId?: string;
	parentTitle?: string;
	parentBranch?: string;
	/** A's commit when B was last put on it, and A's commit now. */
	recordedSha?: string;
	currentSha?: string | null;
	/** A moved since: B should be updated. */
	moved?: boolean;
	/** A was merged: B goes onto A's base. */
	parentMerged?: boolean;
	/** The branch B goes onto when A is merged. */
	nextBase?: string;
	childStarted?: boolean;
	running?: boolean;
}

export function isSafeBranch(name: unknown): name is string {
	return (
		typeof name === "string" &&
		BRANCH.test(name) &&
		!name.includes("..") &&
		!name.startsWith("-") &&
		!name.endsWith("/") &&
		!name.endsWith(".lock")
	);
}

export function branchOf(specId: string): string {
	return `${STACK_BRANCH_PREFIX}${specId}`;
}

function sameTask(task: Task, idOrSpec: string): boolean {
	return task.id === idOrSpec || task.specId === idOrSpec;
}

/** Why B cannot be stacked on A, or null when it can (the main checks git). */
export function stackRefusal(
	child: Task,
	parent: Task,
	tasks: readonly Task[],
): StackRefusal | null {
	if (child.id === parent.id) return "same_task";
	if (child.metadata?.stackParent) return "already_stacked";
	const blockers = child.metadata?.blockedBy ?? [];
	if (!blockers.some((id) => sameTask(parent, id))) return "not_blocker";
	if (parent.status === "done") return "parent_done";
	// Up A's own stack and blockers: meeting B again would close a loop.
	const seen = new Set<string>();
	const queue: Task[] = [parent];
	while (queue.length > 0) {
		const current = queue.shift() as Task;
		if (seen.has(current.id)) continue;
		seen.add(current.id);
		const next = [
			...(current.metadata?.blockedBy ?? []),
			...(current.metadata?.stackParent ? [current.metadata.stackParent] : []),
		];
		for (const id of next) {
			if (sameTask(child, id)) return "cycle";
			const found = tasks.find((t) => sameTask(t, id));
			if (found) queue.push(found);
		}
	}
	return null;
}

/** The metadata that puts B on A (`detect_base_branch` and the worktree read it). */
export function stackMetadata(
	parentSpecId: string,
	parentSha: string,
	trunk: string,
): Record<string, unknown> {
	return {
		baseBranch: branchOf(parentSpecId),
		// Start from A's local commit: `origin/workpilot/<A>` may be older.
		useLocalBranch: true,
		stackParent: parentSpecId,
		stackParentSha: parentSha,
		stackTrunk: trunk,
	};
}

/**
 * The metadata once A is merged into `base`: B targets `base`, and stays
 * stacked when `base` is itself a task's branch (A was stacked on it).
 */
export function afterParentMerged(
	base: string,
	baseSha: string,
	trunk: string,
): Record<string, unknown> {
	if (base.startsWith(STACK_BRANCH_PREFIX)) {
		const grandParent = base.slice(STACK_BRANCH_PREFIX.length);
		if (SPEC_ID.test(grandParent)) {
			return stackMetadata(grandParent, baseSha, trunk);
		}
	}
	return {
		baseBranch: base,
		useLocalBranch: null,
		stackParent: null,
		stackParentSha: null,
		stackTrunk: null,
	};
}
