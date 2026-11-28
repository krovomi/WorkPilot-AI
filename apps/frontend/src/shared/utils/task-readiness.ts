/**
 * What the pre-analysis of a card about to start looks at, shared by the main
 * process (which runs it) and the renderer (which says it is running).
 * Design: docs/architecture/task-readiness.md.
 */
import type { Task, TaskStatus } from "../types";
import { stripHtmlTags } from "./acceptance-criteria";

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
	return cardBody(task).length < SHORT_CARD_CHARS;
}

/** Whether a description is rich text (the edit dialog, a tracker import). */
export function isHtmlDescription(description: string | undefined): boolean {
	return (description ?? "").trimStart().startsWith("<");
}

/**
 * What a card says besides its title, as text: "" when its description only
 * repeats it. Rich text is read without its tags, so a described card is not
 * taken for an empty one (or the reverse) because of its markup.
 */
export function cardBody(task: Pick<Task, "title" | "description">): string {
	const raw = (task.description ?? "").trim();
	const description = isHtmlDescription(raw)
		? stripHtmlTags(raw.replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, "\n"))
				.replace(/&nbsp;/g, " ")
				.replace(/[ \t]+/g, " ")
				.replace(/\s*\n\s*/g, "\n")
				.trim()
		: raw;
	return description === task.title.trim() ? "" : description;
}
