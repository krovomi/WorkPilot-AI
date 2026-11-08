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

import type {
	AutoSplitSettings,
	SplitKind,
	Task,
	TaskCategory,
	TaskKind,
} from "../types";

/**
 * The backend's defaults (`task_split/policy.py`): lines a person reviews per
 * pull request, by kind of task. Code counts in full, tests and docs half,
 * generated files and lockfiles nothing (`task_split/review_load.py`).
 */
export const AUTO_SPLIT_DEFAULT_MAX_LINES_BY_KIND: Readonly<
	Record<SplitKind, number>
> = {
	hotfix: 100,
	bug_fix: 200,
	feature: 400,
	refactoring: 300,
	upgrade: 200,
	test: 400,
	docs: 400,
};
/** The kinds the settings list, in this order. */
export const SPLIT_KINDS: readonly SplitKind[] = [
	"feature",
	"bug_fix",
	"hotfix",
	"refactoring",
	"upgrade",
	"test",
	"docs",
];
/** Kinds with no code to review: never split, unless the task sets a ceiling. */
export const NEVER_SPLIT_KINDS: readonly TaskKind[] = [
	"investigation",
	"spike",
	"run",
];
export const AUTO_SPLIT_DEFAULT_MAX_LINES =
	AUTO_SPLIT_DEFAULT_MAX_LINES_BY_KIND.feature;
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
	const byKind: Partial<Record<SplitKind, number>> = {};
	for (const kind of SPLIT_KINDS) {
		const lines = wholeInRange(
			settings.maxLinesByKind?.[kind],
			SPLIT_MAX_LINES_RANGE,
		);
		if (lines !== undefined) byKind[kind] = lines;
	}
	if (Object.keys(byKind).length > 0) {
		env.WORKPILOT_SPLIT_MAX_LINES_BY_KIND = JSON.stringify(byKind);
	}
	const files = wholeInRange(settings.maxFiles, SPLIT_MAX_FILES_RANGE);
	if (files !== undefined) env.WORKPILOT_SPLIT_MAX_FILES = String(files);
	return env;
}

/** The kind a category means (`tasks/classify.py`, `_BY_CATEGORY`). */
const KIND_BY_CATEGORY: Partial<Record<TaskCategory, TaskKind>> = {
	feature: "feature",
	bug_fix: "bug_fix",
	refactoring: "refactoring",
	documentation: "docs",
	testing: "test",
	infrastructure: "run",
};

export function kindFromCategory(category?: TaskCategory | ""): TaskKind {
	return (category && KIND_BY_CATEGORY[category]) || "feature";
}

/**
 * The project's ceiling for a task of `kind`, or undefined when that kind is
 * never split.
 */
export function autoSplitCeilingFor(
	settings: AutoSplitSettings | undefined,
	kind: TaskKind | undefined,
): number | undefined {
	const k = kind ?? "feature";
	if (NEVER_SPLIT_KINDS.includes(k)) return undefined;
	const splitKind = (k in AUTO_SPLIT_DEFAULT_MAX_LINES_BY_KIND
		? k
		: "feature") as SplitKind;
	return (
		wholeInRange(settings?.maxLinesByKind?.[splitKind], SPLIT_MAX_LINES_RANGE) ??
		AUTO_SPLIT_DEFAULT_MAX_LINES_BY_KIND[splitKind]
	);
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

/** The PR a task opened, from the task or its metadata. */
export function prUrlOf(task: Pick<Task, "prUrl" | "metadata">): string | undefined {
	return task.prUrl ?? task.metadata?.prUrl ?? undefined;
}

/**
 * The parts whose PR may have been merged since the last look: a local part
 * with a PR, still on the board, not done. Server cards are left to the
 * server, which runs no git here.
 */
export function partsAwaitingMerge<
	T extends Pick<Task, "id" | "status" | "prUrl" | "metadata">,
>(tasks: readonly T[]): T[] {
	return tasks.filter(
		(task) =>
			splitPartOf(task) !== null &&
			!isServerTask(task) &&
			!task.metadata?.archivedAt &&
			(task.status === "pr_created" || task.status === "human_review") &&
			Boolean(prUrlOf(task)),
	);
}

/**
 * The parts stacked on a part of the same split that is now done: each one
 * moves onto that part's base, and its PR is retargeted (`stackUpdate`).
 */
export function partsToMoveOntoBase<
	T extends Pick<Task, "id" | "specId" | "status" | "metadata">,
>(tasks: readonly T[]): T[] {
	return tasks.filter((task) => {
		const mine = splitPartOf(task);
		const parentSpec = task.metadata?.stackParent;
		if (!mine || !parentSpec || isServerTask(task)) return false;
		const parent = tasks.find(
			(t) => t.specId === parentSpec || t.id === parentSpec,
		);
		return (
			parent !== undefined &&
			parent.status === "done" &&
			splitPartOf(parent)?.parent === mine.parent
		);
	});
}

/**
 * The charter tones a split group can take, in the order the hash indexes
 * them; the backend (`task_split/group.py`) and the phone use the same list
 * and the same hash, so a group has one colour on the board, the phone and
 * its forge label.
 */
export const SPLIT_GROUP_TONES = ["blue", "violet", "green", "amber", "pink", "orange"] as const;
export type SplitGroupTone = (typeof SPLIT_GROUP_TONES)[number];

/** FNV-1a (32 bits) of the group id's UTF-8 bytes, modulo the six tones. */
export function splitGroupTone(groupId: string): SplitGroupTone {
	let value = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(groupId)) {
		value ^= byte;
		value = Math.imul(value, 0x01000193) >>> 0;
	}
	return SPLIT_GROUP_TONES[value % SPLIT_GROUP_TONES.length];
}

/** The group a card belongs to: a part's split task, or the split task itself. */
export function splitGroupId(task: Pick<Task, "specId" | "metadata">): string | null {
	const group = task.metadata?.splitGroup;
	if (group?.parent) return group.parent;
	if (group?.children?.length) return task.specId;
	return null;
}
