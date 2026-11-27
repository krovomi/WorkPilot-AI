/**
 * The team's leaderboard (`shared_features/pixel_office.py`) and the
 * person's own replay links (`shared_features/replay_share_overview.py`),
 * as the server answers them.
 */

export type LeaderboardScope = "project" | "org";
export type LeaderboardPeriod = "season" | "all";

/** The badges the server counts, since the start; another id is not shown. */
export const BADGES = ["first_delivery", "ten_deliveries", "complex_delivery", "first_review", "ten_reviews"] as const;
export type Badge = (typeof BADGES)[number];

export interface LeaderboardEntry {
	rank: number;
	name: string;
	delivered: number;
	reviews: number;
	points: number;
	badges: string[];
	you: boolean;
}

export interface Leaderboard {
	scope: LeaderboardScope;
	period: LeaderboardPeriod;
	season: { start: string; end: string };
	projects: number;
	/** Only the people who chose to show their name. */
	entries: LeaderboardEntry[];
	/** The person's own score, whatever they chose. */
	me: {
		visible: boolean;
		delivered: number;
		reviews: number;
		points: number;
		badges: string[];
		rank: number | null;
	};
}

export type ShareState = "active" | "expired" | "revoked";

export interface ReplayShare {
	id: string;
	title: string;
	steps: number;
	size_bytes: number;
	created_at: string | null;
	expires_at: string | null;
	state: ShareState;
	open_count: number;
	last_opened_at: string | null;
	can_revoke: boolean;
	project_id: string;
	project_name: string;
}

export function knownBadges(badges: readonly string[]): Badge[] {
	return BADGES.filter((badge) => badges.includes(badge));
}
