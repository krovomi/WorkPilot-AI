/**
 * What the pre-analysis of a card about to start looks at, shared by the main
 * process (which runs it) and the renderer (which says it is running).
 * Design: docs/architecture/task-readiness.md.
 */
import type { Task, TaskStatus } from "../types";

/** Below this many characters of description (title aside), a card is short. */
export const SHORT_CARD_CHARS = 80;

/** Statuses a card starts from for the first time: the pre-analysis runs there only. */
const FIRST_START_FROM: readonly TaskStatus[] = ["backlog", "queue"];

/** Whether moving this card to « En cours » is its first start. */
export function isFirstStart(task: Pick<Task, "status">): boolean {
	return FIRST_START_FROM.includes(task.status);
}

/**
 * A card with a title and little else, never planned: the agent would have to
 * guess what it means. Only such a card gets the AI review.
 */
export function isShortCard(task: Pick<Task, "title" | "description" | "subtasks">): boolean {
	if (task.subtasks.length > 0) return false;
	const description = (task.description ?? "").trim();
	const body = description === task.title.trim() ? "" : description;
	return body.length < SHORT_CARD_CHARS;
}
