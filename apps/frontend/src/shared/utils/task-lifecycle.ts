/**
 * Pure helpers for the human-review "close" and "abandon/resume" workflows.
 *
 * Kept free of React/Electron so they can be unit-tested in isolation and reused
 * by both the Kanban board and the task-detail modal.
 */

import type { Task, TaskMetadata } from "../types/task";

/**
 * "Definition of Done" checklist surfaced before a task is closed from human
 * review. The guard is intentionally SOFT: `ready` being false only drives a
 * warning + "close anyway" affordance, never a hard block — a task can be
 * legitimately closed without a WorkPilot PR (e.g. merged on the platform) or
 * without captured visual proof (e.g. a non-UI change).
 */
export interface CompletionChecklist {
	/** A PR/MR URL is linked to the task. */
	hasPr: boolean;
	/** At least one visual-proof screenshot was captured. */
	hasVisualProof: boolean;
	/** Every soft guard is satisfied (nothing to warn about). */
	ready: boolean;
}

/** Compute the close-time Definition-of-Done checklist for a task. */
export function computeCompletionChecklist(
	task: Pick<Task, "prUrl" | "metadata">,
): CompletionChecklist {
	const hasPr = Boolean(task.prUrl ?? task.metadata?.prUrl);
	const proof = task.metadata?.visualProof;
	const hasVisualProof = Boolean(proof?.screenshots?.length);
	return { hasPr, hasVisualProof, ready: hasPr && hasVisualProof };
}

/** Whether the task is currently abandoned. */
export function isTaskAbandoned(task: Pick<Task, "metadata">): boolean {
	return task.metadata?.abandoned === true;
}

/**
 * Metadata patch that marks a task abandoned. Merged onto the existing metadata
 * (see TASK_UPDATE), so only the abandon fields are set. An empty/whitespace
 * reason is omitted rather than stored as a blank string.
 */
export function buildAbandonMetadata(
	reason?: string,
	now: Date = new Date(),
): Partial<TaskMetadata> {
	const trimmed = reason?.trim();
	return {
		abandoned: true,
		abandonedAt: now.toISOString(),
		...(trimmed ? { abandonedReason: trimmed } : {}),
	};
}

/**
 * Metadata patch that reactivates an abandoned task. `abandoned: false` (not
 * deletion) is enough since {@link isTaskAbandoned} checks strict equality;
 * the reason is cleared so a resumed task reads clean.
 */
export function buildResumeMetadata(): Partial<TaskMetadata> {
	return { abandoned: false, abandonedReason: undefined };
}
