/**
 * "For you": the cards, across the person's projects, that wait on someone
 * like them. A card waits in Human Review: its plan to approve, a build to
 * review and merge, or a run that stopped and needs a look. A card claimed by
 * someone else is theirs; one the person's permissions could not act on is
 * left out, as the card screen would show it no button.
 *
 * Read from each project's own board route (`GET /api/board/cards`), so the
 * server checks every project as it does for the board.
 */

import type { TFunction } from "i18next";
import type { BoardCard, ServerProject } from "../api/types";

export type InboxReason = "plan" | "attention" | "review";

/** Plans first (nothing moves until approved), then what stopped, then what is done. */
export const REASONS: readonly InboxReason[] = ["plan", "attention", "review"];

/** The review reasons (`ReviewReason` on the desktop) that mean a run stopped short. */
const STOPPED = new Set(["errors", "qa_rejected", "stopped", "prompt_too_long"]);

/** At most this many projects are read for the inbox, one request each. */
export const MAX_INBOX_PROJECTS = 30;

export function inboxReason(
	card: BoardCard,
	userId: string | null,
	can: (permission: string) => boolean,
): InboxReason | null {
	if (card.column !== "human_review") return null;
	if (card.claimedBy && card.claimedBy !== userId) return null;
	if (card.reviewReason === "plan_review") return can("review.approve") ? "plan" : null;
	if (!can("agent.execute")) return null;
	if (card.reviewReason && STOPPED.has(card.reviewReason)) return "attention";
	return can("task.merge") || can("vcs.pr.create") ? "review" : null;
}

export interface InboxItem {
	project: ServerProject;
	card: BoardCard;
	reason: InboxReason;
}

export interface Inbox {
	items: InboxItem[];
	/** The projects whose board could not be read this time, by name. */
	unreachable: string[];
}

export async function loadInbox(
	projects: readonly ServerProject[],
	cardsOf: (projectId: string) => Promise<BoardCard[]>,
	userId: string | null,
	can: (permission: string) => boolean,
): Promise<Inbox> {
	const read = projects.slice(0, MAX_INBOX_PROJECTS);
	const boards = await Promise.allSettled(read.map((project) => cardsOf(project.id)));
	const items: InboxItem[] = [];
	const unreachable: string[] = [];
	boards.forEach((board, index) => {
		const project = read[index];
		if (board.status === "rejected") {
			unreachable.push(project.name);
			return;
		}
		for (const card of board.value) {
			const reason = inboxReason(card, userId, can);
			if (reason) items.push({ project, card, reason });
		}
	});
	items.sort(
		(a, b) =>
			REASONS.indexOf(a.reason) - REASONS.indexOf(b.reason) ||
			(b.card.updatedAt ?? "").localeCompare(a.card.updatedAt ?? ""),
	);
	return { items, unreachable };
}

/** "2 plans to approve · 1 to review": how many wait for each reason, the empty ones left out. */
export function inboxSummary(items: readonly InboxItem[], t: TFunction): string {
	return REASONS.map((reason) => ({ reason, count: items.filter((item) => item.reason === reason).length }))
		.filter(({ count }) => count > 0)
		.map(({ reason, count }) => t(`inbox.parts.${reason}`, { count }))
		.join(" · ");
}
