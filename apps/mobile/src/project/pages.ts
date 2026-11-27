/**
 * A project's pages on the phone and who sees them. The tab bar keeps the
 * four a person opens most (the board, Insights, the forge, the dashboard);
 * the rest are rows of the "More" tab. A page the person's permissions
 * would refuse is not shown (the server checks again). The team's pages
 * (its chat, its leaderboard) come first.
 */

import type { IconName } from "../ui/Icon";

export type TabPage = "insights" | "forge" | "dashboard";
export type MorePage =
	| "chat"
	| "leaderboard"
	| "roadmap" 	| "ideas"
	| "context"
	| "sessions"
	| "analyses"
	| "delegations"
	| "governance"
	| "waves";

export const PAGE_ICONS: Record<TabPage | MorePage | "board" | "more", IconName> = {
	board: "trello",
	insights: "message-circle",
	forge: "git-pull-request",
	dashboard: "bar-chart-2",
	more: "grid",
	chat: "message-square",
	leaderboard: "award",
	roadmap: "map",
	ideas: "zap",
	context: "book-open",
	sessions: "activity",
	analyses: "cpu",
	delegations: "user-check",
	governance: "shield",
	waves: "layers",
};

const MORE_PERMISSIONS: Record<MorePage, string> = {
	chat: "task.read",
	leaderboard: "analytics.read",
	roadmap: "insight.read",
	ideas: "insight.read",
	context: "insight.read",
	sessions: "analytics.read",
	analyses: "analytics.read",
	delegations: "review.approve",
	governance: "audit.read",
	waves: "task.read",
};

/** Whether a tab is shown: the forge's needs a forge on the project. */
export function showsTab(page: TabPage, can: (permission: string) => boolean, hasForge: boolean): boolean {
	switch (page) {
		case "insights":
			return can("insight.read");
		case "forge":
			return hasForge && can("vcs.read");
		case "dashboard":
			return can("analytics.read");
	}
}

/** The rows of the "More" tab the person may open, in order. */
export function morePages(can: (permission: string) => boolean): MorePage[] {
	return (Object.keys(MORE_PERMISSIONS) as MorePage[]).filter((page) => can(MORE_PERMISSIONS[page]));
}
