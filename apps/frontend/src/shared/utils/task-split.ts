/**
 * Automatic split of a task too big for one small pull request: the rules
 * the app shares with the backend (`apps/backend/task_split/`), without I/O.
 *
 * The backend measures the plan and writes the parts; the app sends the
 * project's ceilings (`autoSplitEnv`), lets a task set its own, and chains
 * the parts: a part that waits for another may start as soon as that one
 * passed QA, stacked on its branch (`task-stack.ts`), instead of waiting for
 * its merge.
 */

import type { AutoSplitSettings, Task } from "../types";

/** The backend's defaults (`task_split/policy.py`). */
export const AUTO_SPLIT_DEFAULT_MAX_LINES = 400;
export const AUTO_SPLIT_DEFAULT_MAX_FILES = 25;
/** The ranges the backend accepts; a value outside is ignored there. */
export const SPLIT_MAX_LINES_RANGE = [50, 20_000] as const;
export const SPLIT_MAX_FILES_RANGE = [2, 1_000] as const;

/** A whole number in `range`, or undefined (an empty or wrong field). */
export function wholeInRange(
	value: unknown,
	range: readonly [number, number],
): number | undefined {
	const n =
		typeof value === "string" && value.trim() !== ""
			? Number(value.trim())
			: value;
	if (typeof n !== "number" || !Number.isInteger(n)) return undefined;
	return n >= range[0] && n <= range[1] ? n : undefined;
}

/** The environment the backend reads the project's ceilings from. */
export function autoSplitEnv(
	settings?: AutoSplitSettings,
): Record<string, string> {
	if (!settings) return {};
	const env: Record<string, string> = {};
	if (settings.enabled === false) env.WORKPILOT_AUTO_SPLIT = "0";
	const lines = wholeInRange(settings.maxLines, SPLIT_MAX_LINES_RANGE);
	if (lines !== undefined) env.WORKPILOT_SPLIT_MAX_LINES = String(lines);
	const files = wholeInRange(settings.maxFiles, SPLIT_MAX_FILES_RANGE);
	if (files !== undefined) env.WORKPILOT_SPLIT_MAX_FILES = String(files);
	return env;
}

export interface SplitPart {
	parent: string;
	title: string;
	index: number;
	total: number;
	name?: string;
}

/** The part a task is, when it came out of a split. */
export function splitPartOf(task: Pick<Task, "metadata">): SplitPart | null {
	const group = task.metadata?.splitGroup;
	if (
		!group?.parent ||
		!Number.isInteger(group.index) ||
		!Number.isInteger(group.total)
	) {
		return null;
	}
	return {
		parent: group.parent,
		title: group.title ?? group.parent,
		index: group.index as number,
		total: group.total as number,
		name: group.name,
	};
}

/** How many parts a task was split into, or 0 when it was not. */
export function splitChildCount(task: Pick<Task, "metadata">): number {
	return task.metadata?.splitGroup?.children?.length ?? 0;
}

/** A server card: its parts cannot be stacked from this computer. */
export function isServerTask(task: Pick<Task, "id">): boolean {
	return task.id.startsWith("server:");
}

/**
 * Whether `blocker`, a part of the same split as `task`, is far enough for
 * `task` to start on top of it: QA passed (the build is complete and waits
 * for its review) or its PR is open. The start then stacks `task` on it.
 * A server card waits for the merge instead: stacking runs git here.
 */
export function canStartOnSibling(
	task: Pick<Task, "id" | "metadata">,
	blocker: Pick<Task, "id" | "status" | "reviewReason" | "metadata">,
): boolean {
	const mine = splitPartOf(task);
	const theirs = splitPartOf(blocker);
	if (!mine || !theirs || mine.parent !== theirs.parent) return false;
	if (isServerTask(task) || isServerTask(blocker)) return false;
	if (blocker.status === "pr_created") return true;
	return (
		blocker.status === "human_review" && blocker.reviewReason === "completed"
	);
}
