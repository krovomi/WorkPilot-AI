/**
 * Pixel Office's team leaderboard and the person's own badges, for a server
 * project (#350). The server computes them from its runs and approvals and
 * names only the people who agreed (`apps/backend/shared_features/
 * pixel_office.py`); nothing is computed or sent anywhere else.
 *
 * The renderer gives a project id the app listed, a scope and a period from
 * closed lists, or a boolean; each is checked here. What the server answers
 * is read again field by field: a name is cut to a label, a count must be a
 * whole number, a badge must be one of the known ones.
 */

import {
	TEAM_BADGE_IDS,
	TEAM_BOARD_PERIODS,
	TEAM_BOARD_SCOPES,
	type TeamBadgeId,
	type TeamBoard,
	type TeamBoardEntry,
	type TeamBoardPeriod,
	type TeamBoardRequest,
	type TeamBoardResult,
	type TeamBoardScope,
	type TeamBoardSelf,
	type TeamConsentResult,
} from "../shared/types/pixel-office";
import { authedFetch, isServerMode } from "./server-connection";
import { getServerProject } from "./server-projects";

/** As `MAX_ENTRIES` and `NAME_MAX` in `shared_features/pixel_office.py`. */
const MAX_ENTRIES = 50;
const NAME_MAX = 200;
const BADGES = new Set<string>(TEAM_BADGE_IDS);
const SCOPES = new Set<string>(TEAM_BOARD_SCOPES);
const PERIODS = new Set<string>(TEAM_BOARD_PERIODS);

type Failure = { success: false; error: string };
const fail = (error: string): Failure => ({ success: false, error });

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number {
	return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function moment(value: unknown): string | null {
	return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value))
		? value
		: null;
}

function badges(value: unknown): TeamBadgeId[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<TeamBadgeId>();
	for (const id of value) {
		if (typeof id === "string" && BADGES.has(id)) seen.add(id as TeamBadgeId);
	}
	return TEAM_BADGE_IDS.filter((id) => seen.has(id));
}

/** What the renderer asks for, or null when malformed. */
export function teamBoardRequest(raw: unknown): TeamBoardRequest | null {
	if (!isRecord(raw)) return null;
	const { scope, period } = raw;
	if (typeof scope !== "string" || !SCOPES.has(scope)) return null;
	if (typeof period !== "string" || !PERIODS.has(period)) return null;
	return { scope: scope as TeamBoardScope, period: period as TeamBoardPeriod };
}

function toEntry(raw: unknown): TeamBoardEntry | null {
	if (!isRecord(raw)) return null;
	const name =
		typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
	const rank = count(raw.rank);
	if (!name || rank < 1) return null;
	return {
		rank,
		name,
		delivered: count(raw.delivered),
		reviews: count(raw.reviews),
		points: count(raw.points),
		badges: badges(raw.badges),
		you: raw.you === true,
	};
}

function toSelf(raw: unknown): TeamBoardSelf {
	const me = isRecord(raw) ? raw : {};
	const rank = count(me.rank);
	return {
		visible: me.visible === true,
		delivered: count(me.delivered),
		reviews: count(me.reviews),
		points: count(me.points),
		badges: badges(me.badges),
		rank: rank >= 1 ? rank : null,
	};
}

/** The server's answer, checked again, or null. */
export function toTeamBoard(raw: unknown, asked: TeamBoardRequest): TeamBoard | null {
	if (!isRecord(raw) || !Array.isArray(raw.entries)) return null;
	const season = isRecord(raw.season) ? raw.season : {};
	const seasonStart = moment(season.start);
	const seasonEnd = moment(season.end);
	if (!seasonStart || !seasonEnd) return null;
	return {
		scope: asked.scope,
		period: asked.period,
		seasonStart,
		seasonEnd,
		projects: count(raw.projects),
		entries: raw.entries
			.slice(0, MAX_ENTRIES)
			.map(toEntry)
			.filter((entry): entry is TeamBoardEntry => entry !== null),
		me: toSelf(raw.me),
	};
}

function projectOf(projectId: unknown) {
	const project = getServerProject(projectId);
	return project && isServerMode() ? project : undefined;
}

export async function getTeamBoard(
	projectId: unknown,
	request: unknown,
): Promise<TeamBoardResult> {
	const project = projectOf(projectId);
	if (!project) return fail("not_a_server_project");
	const asked = teamBoardRequest(request);
	if (!asked) return fail("Invalid leaderboard request");
	const query = new URLSearchParams({
		project_id: project.id,
		scope: asked.scope,
		period: asked.period,
	});
	const answer = await authedFetch<unknown>(
		`/api/features/pixel-office/leaderboard?${query.toString()}`,
		"GET",
	);
	if (!answer.ok) return fail(answer.error);
	const board = toTeamBoard(answer.data, asked);
	return board ? { success: true, board } : fail("bad_leaderboard");
}

export async function setTeamConsent(
	projectId: unknown,
	visible: unknown,
): Promise<TeamConsentResult> {
	const project = projectOf(projectId);
	if (!project) return fail("not_a_server_project");
	if (typeof visible !== "boolean") return fail("Invalid consent");
	const answer = await authedFetch<unknown>(
		`/api/features/pixel-office/consent?project_id=${encodeURIComponent(project.id)}`,
		"PUT",
		{ visible },
	);
	if (!answer.ok) return fail(answer.error);
	const saved = isRecord(answer.data) ? answer.data.visible : undefined;
	return typeof saved === "boolean" ? { success: true, visible: saved } : fail("bad_consent");
}
