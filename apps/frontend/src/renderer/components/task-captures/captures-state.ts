/**
 * Where a task's captures stand, in one word, for the card's badge, its
 * hover preview and the Captures tab (`shared/types/task-captures.ts`).
 */

import type { Task, TaskCapturesSummary } from "../../../shared/types";

/**
 * - `published`: the PR shows them (its « Captures » section);
 * - `waiting`: review mode, waiting for a person's « Publish »;
 * - `ready`: publishable, the PR does not show them yet (no PR, or not synced);
 * - `kept`: the team keeps captures on the task (`CAPTURES_PUBLISH=never`);
 * - `withheld`: none of them could be checked, so none leaves the machine.
 */
export type CapturesState = "published" | "waiting" | "ready" | "kept" | "withheld";

export function capturesState(summary: TaskCapturesSummary): CapturesState {
	if (summary.publish === "never") return "kept";
	if (summary.publishable === 0) return "withheld";
	if (summary.publish === "review" && !summary.approved) return "waiting";
	if (summary.sync?.status === "published" && summary.sync.section) return "published";
	return "ready";
}

/** The task has screens to show: a badge on the card, the tab's gallery. */
export function hasScreens(summary: TaskCapturesSummary | undefined | null): summary is TaskCapturesSummary {
	return Boolean(summary?.needed && summary.items.length > 0);
}

export const CAPTURES_STATE_VARIANT: Record<
	CapturesState,
	"success" | "warning" | "info" | "muted" | "destructive"
> = {
	published: "success",
	waiting: "warning",
	ready: "info",
	kept: "muted",
	withheld: "destructive",
};

/** The first copy worth showing small: an "after" the PR would show. */
export function firstPreviewFile(summary: TaskCapturesSummary): string | undefined {
	return summary.items.find((item) => item.after.available)?.after.file;
}

/** The kinds of personal data replaced by fakes, over every copy. */
export function replacedKinds(summary: TaskCapturesSummary): string[] {
	const kinds = new Set<string>();
	for (const item of summary.items) {
		for (const side of [item.after, item.before]) {
			if (side && side.replaced > 0) for (const kind of side.kinds) kinds.add(kind);
		}
	}
	return [...kinds].sort();
}

/** For `TaskCard`'s memo: the badge changes only with these. */
export function sameCaptures(prev: Task, next: Task): boolean {
	const a = prev.captures;
	const b = next.captures;
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.generatedAt === b.generatedAt &&
		a.items.length === b.items.length &&
		a.publishable === b.publishable &&
		a.publish === b.publish &&
		a.approved === b.approved &&
		a.sync?.status === b.sync?.status &&
		a.sync?.section === b.sync?.section &&
		a.sync?.syncedAt === b.sync?.syncedAt
	);
}
