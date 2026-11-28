/**
 * Auto-archive of the Kanban (Jira's « done issues older than… »): a card
 * finished more than N days ago is archived, as the « Archive » button does,
 * and stays one click away under « Show archived ». Off until the person
 * picks a delay in the settings (`kanbanAutoArchiveDays`).
 *
 * Run by `main/kanban-auto-archive.ts` on local projects only.
 * Design: docs/architecture/kanban-auto-archive.md.
 */
import type { Task } from "../types/task";

/** The delays offered, in days; 0 is off. */
export const AUTO_ARCHIVE_CHOICES = [0, 7, 14, 30] as const;
export type AutoArchiveDays = (typeof AUTO_ARCHIVE_CHOICES)[number];

const DAY = 86_400_000;

/** The setting as the app reads it: one of the choices, anything else is off. */
export function autoArchiveDays(raw: unknown): AutoArchiveDays {
	return (AUTO_ARCHIVE_CHOICES as readonly unknown[]).includes(raw) ? (raw as AutoArchiveDays) : 0;
}

function time(value: unknown): number | null {
	if (value === undefined || value === null || value === "") return null;
	const parsed = new Date(value as string | Date).getTime();
	return Number.isNaN(parsed) ? null : parsed;
}

/** When a card was last moved to « Done » (its status history, else its last change). */
export function finishedAt(task: Pick<Task, "statusHistory" | "updatedAt">): number | null {
	const history = task.statusHistory ?? [];
	for (let index = history.length - 1; index >= 0; index--) {
		if (history[index].to === "done") return time(history[index].at);
	}
	return time(task.updatedAt);
}

/** The ids of the cards done for more than `days` days and not archived yet. */
export function autoArchiveIds(tasks: readonly Task[], days: number, now: number): string[] {
	if (days <= 0) return [];
	const before = now - days * DAY;
	return tasks
		.filter((task) => {
			if (task.status !== "done" || task.metadata?.archivedAt || task.id.startsWith("server:")) return false;
			const at = finishedAt(task);
			return at !== null && at < before;
		})
		.map((task) => task.id);
}
