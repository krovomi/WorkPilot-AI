/**
 * Pixel Office types the renderer and the main process both read: the
 * provider families the characters are dressed in, and the request for an
 * LLM-written mini-scene (`PIXEL_OFFICE_NARRATE`).
 */

/** One shirt colour per provider family, so a glance tells who runs what. */
export const PROVIDER_FAMILIES = [
	"anthropic",
	"openai",
	"google",
	"ollama",
	"copilot",
	"grok",
	"custom",
] as const;

export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

/** What just happened to a task, as a scene in the office. */
export const NARRATIVE_KINDS = [
	"plan-ready",
	"handed-to-qa",
	"qa-sent-back",
	"qa-approved",
	"shipped",
	"stumbled",
] as const;

export type NarrativeKind = (typeof NARRATIVE_KINDS)[number];

/** The agents a scene can name: the pipeline's roles, and the person. */
export const NARRATIVE_ROLES = [
	"planner",
	"coder",
	"reviewer",
	"fixer",
	"you",
] as const;

export type NarrativeRole = (typeof NARRATIVE_ROLES)[number];

/** The languages a scene can be written in (the app's own). */
export const NARRATIVE_LANGUAGES = ["en", "fr"] as const;

export type NarrativeLanguage = (typeof NARRATIVE_LANGUAGES)[number];

/**
 * A scene to write: every field is checked again by the main process. Only
 * closed lists and a spec number: the model never sees the task's content.
 */
export interface NarrativeRequest {
	kind: NarrativeKind;
	/** The spec's number (`042`), or empty. */
	spec: string;
	from?: NarrativeRole;
	to?: NarrativeRole;
	/** The provider family the first agent runs on. */
	fromFamily?: ProviderFamily;
	toFamily?: ProviderFamily;
	language: NarrativeLanguage;
}

export type NarrativeResult =
	| { success: true; text: string }
	| { success: false };

/**
 * A person's badges on a server, counted there since the start
 * (`apps/backend/shared_features/pixel_office.py`, `BADGES`).
 */
export const TEAM_BADGE_IDS = [
	"first_delivery",
	"ten_deliveries",
	"complex_delivery",
	"first_review",
	"ten_reviews",
] as const;

export type TeamBadgeId = (typeof TEAM_BADGE_IDS)[number];

/** The project alone, or its organization's projects the person may read. */
export const TEAM_BOARD_SCOPES = ["project", "org"] as const;
export type TeamBoardScope = (typeof TEAM_BOARD_SCOPES)[number];

/** This quarter, or since the start. */
export const TEAM_BOARD_PERIODS = ["season", "all"] as const;
export type TeamBoardPeriod = (typeof TEAM_BOARD_PERIODS)[number];

export interface TeamBoardRequest {
	scope: TeamBoardScope;
	period: TeamBoardPeriod;
}

/** Someone who agreed to show by name on the leaderboard. */
export interface TeamBoardEntry {
	rank: number;
	name: string;
	delivered: number;
	reviews: number;
	points: number;
	badges: TeamBadgeId[];
	/** The person looking at it. */
	you: boolean;
}

/** The person's own score and badges, whether or not they show by name. */
export interface TeamBoardSelf {
	visible: boolean;
	delivered: number;
	reviews: number;
	points: number;
	badges: TeamBadgeId[];
	/** Their rank among the people named; null when they are not named. */
	rank: number | null;
}

export interface TeamBoard {
	scope: TeamBoardScope;
	period: TeamBoardPeriod;
	seasonStart: string;
	seasonEnd: string;
	/** How many projects were counted. */
	projects: number;
	entries: TeamBoardEntry[];
	me: TeamBoardSelf;
}

export type TeamBoardResult =
	| { success: true; board: TeamBoard }
	| { success: false; error: string };

export type TeamConsentResult =
	| { success: true; visible: boolean }
	| { success: false; error: string };
