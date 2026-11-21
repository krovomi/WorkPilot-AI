/**
 * A recorded agent session left with a server project's team (#347): the
 * link that opens it, the project's list of links, the person's own links
 * on every project (Settings), revoking one.
 *
 * The local backend builds the `.wpreplay`, masked as for a file
 * (`apps/backend/replay/bundle.py`); main sends it to the server the app is
 * signed in to (`apps/backend/shared_features/replay_shares.py`), which keeps
 * it with the project and answers a token, once. The link is
 * `workpilot-replay://<server host>/<project id>/<share id>#<token>`: a
 * teammate pastes it in the app, which checks it names this server and a
 * project the app listed, then sends the token in the body of the request,
 * never in a URL. What comes back is a bundle like a file someone sent: the
 * local backend imports it, rebuilt field by field.
 *
 * The renderer gives a session id, a project id the app listed, a number of
 * days from a closed list and booleans; or the link the person pasted. Each
 * is checked here.
 */

import type {
	ReplayImportResult,
	ReplayMyTeamShare,
	ReplayMyTeamShareListResult,
	ReplayTeamShare,
	ReplayTeamShareListResult,
	ReplayTeamShareResult,
} from "../shared/types/replay-share";
import { REPLAY_SHARE_TTL_DAYS } from "../shared/types/replay-share";
import { backendFetch } from "./ipc-handlers/_backend-fetch";
import { isReplayId } from "./ipc-handlers/replay-handlers";
import { exportedFile } from "./ipc-handlers/replay-share-handlers";
import { recordReplayExport } from "./replay-usage";
import { authedFetch, getServerUrl, isServerMode } from "./server-connection";
import { getServerProject } from "./server-projects";

/** As `MAX_SHARED_BYTES` in `apps/backend/shared_features/replay_shares.py`. */
export const MAX_SHARED_BYTES = 10 * 1024 * 1024;
export const LINK_SCHEME = "workpilot-replay:";
const MAX_LINK = 512;
const MAX_SHARES = 200;
const MAX_TITLE = 200;
const TIMEOUT_MS = 120_000;
const SHARE_ID = /^[0-9a-f-]{36}$/;
/** `secrets.token_urlsafe(32)`: 43 characters of base64url. */
const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const STATES = new Set<ReplayTeamShare["state"]>(["active", "expired", "revoked"]);
const TTLS = new Set<number>(REPLAY_SHARE_TTL_DAYS);

type Failure = { success: false; error: string; unreachable?: true };
const fail = (error: string): Failure => ({ success: false, error });

export interface ShareLink {
	host: string;
	projectId: string;
	shareId: string;
	token: string;
}

/** The host a link names for the server at `serverUrl`, or null. */
function hostOf(serverUrl: string): string | null {
	try {
		return new URL(serverUrl).host || null;
	} catch {
		return null;
	}
}

export function buildShareLink(
	serverUrl: string,
	projectId: string,
	shareId: string,
	token: string,
): string | null {
	const host = hostOf(serverUrl);
	if (!host || !SHARE_ID.test(shareId) || !TOKEN.test(token)) return null;
	return `${LINK_SCHEME}//${host}/${encodeURIComponent(projectId)}/${shareId}#${token}`;
}

/** The parts of a pasted link, or null when it is not one. */
export function parseShareLink(raw: unknown): ShareLink | null {
	if (typeof raw !== "string" || raw.length > MAX_LINK) return null;
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (url.protocol !== LINK_SCHEME || !url.host || url.search) return null;
	const parts = url.pathname.split("/").filter(Boolean);
	const token = url.hash.slice(1);
	if (parts.length !== 2 || !TOKEN.test(token)) return null;
	const [projectId, shareId] = parts;
	if (!PROJECT_ID.test(projectId) || !SHARE_ID.test(shareId)) return null;
	return { host: url.host, projectId, shareId, token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function label(value: unknown, limit: number): string | undefined {
	return typeof value === "string" && value.length > 0
		? value.slice(0, limit)
		: undefined;
}

function moment(value: unknown): string | undefined {
	const text = label(value, 64);
	return text && !Number.isNaN(Date.parse(text)) ? text : undefined;
}

function count(value: unknown): number {
	return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

/** A share of the server's list, checked again, or null. */
export function toTeamShare(raw: unknown): ReplayTeamShare | null {
	if (!isRecord(raw)) return null;
	const id = typeof raw.id === "string" && SHARE_ID.test(raw.id) ? raw.id : null;
	const createdAt = moment(raw.created_at);
	const expiresAt = moment(raw.expires_at);
	const state = raw.state as ReplayTeamShare["state"];
	if (!id || !createdAt || !expiresAt || !STATES.has(state)) return null;
	const share: ReplayTeamShare = {
		id,
		title: label(raw.title, MAX_TITLE) ?? "session",
		steps: count(raw.steps),
		createdBy: label(raw.created_by, MAX_TITLE) ?? "",
		createdAt,
		expiresAt,
		state,
		openCount: count(raw.open_count),
		canRevoke: raw.can_revoke === true,
	};
	const opened = moment(raw.last_opened_at);
	if (opened) share.lastOpenedAt = opened;
	return share;
}

export interface TeamShareBody {
	projectId: string;
	ttlDays: number;
	stripReasoning: boolean;
	stripTokens: boolean;
	includeFileContents: boolean;
}

/** What the renderer asks to share, or null when malformed. */
export function teamShareBody(raw: unknown): TeamShareBody | null {
	if (!isRecord(raw)) return null;
	const { projectId, ttlDays } = raw;
	if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) return null;
	if (typeof ttlDays !== "number" || !TTLS.has(ttlDays)) return null;
	const flags = [raw.stripReasoning, raw.stripTokens, raw.includeFileContents];
	if (flags.some((f) => f !== undefined && typeof f !== "boolean")) return null;
	return {
		projectId,
		ttlDays,
		stripReasoning: flags[0] === true,
		stripTokens: flags[1] === true,
		includeFileContents: flags[2] === true,
	};
}

const sharesRoute = (projectId: string, tail = "") =>
	`/api/features/replay-shares${tail}?project_id=${encodeURIComponent(projectId)}`;

/** Build the masked bundle here, leave it with the project, answer its link. */
export async function shareToTeam(
	sessionId: unknown,
	request: unknown,
): Promise<ReplayTeamShareResult> {
	if (!isReplayId(sessionId)) return fail("Invalid session id");
	const body = teamShareBody(request);
	if (!body) return fail("Invalid share options");
	const project = getServerProject(body.projectId);
	const serverUrl = getServerUrl();
	if (!project || !serverUrl || !isServerMode()) return fail("not_a_server_project");
	const built = await backendFetch<{ content_base64: string }>(
		`/replay/sessions/${sessionId}/export`,
		{
			method: "POST",
			body: JSON.stringify({
				format: "wpreplay",
				strip_reasoning: body.stripReasoning,
				strip_tokens: body.stripTokens,
				include_file_contents: body.includeFileContents,
			}),
		},
		TIMEOUT_MS,
	);
	if (!built.success) return built;
	const content = exportedFile(built.content_base64, "wpreplay");
	if (!content) return fail("bad_export");
	if (content.length > MAX_SHARED_BYTES) return fail("too_large_to_share");
	const answer = await authedFetch<unknown>(sharesRoute(project.id), "POST", {
		content_base64: content.toString("base64"),
		ttl_days: body.ttlDays,
	});
	if (!answer.ok) return fail(answer.error);
	const data = isRecord(answer.data) ? answer.data : {};
	const share = toTeamShare(data.share);
	const link =
		share && typeof data.token === "string"
			? buildShareLink(serverUrl, project.id, share.id, data.token)
			: null;
	if (!share || !link) return fail("bad_share");
	await recordReplayExport("team_link");
	return { success: true, link, share };
}

/** The links of a server project, the latest first. */
export async function listTeamShares(
	projectId: unknown,
): Promise<ReplayTeamShareListResult> {
	const project = getServerProject(projectId);
	if (!project) return fail("not_a_server_project");
	const answer = await authedFetch<unknown>(sharesRoute(project.id), "GET");
	if (!answer.ok) return fail(answer.error);
	const rows = isRecord(answer.data) ? answer.data.shares : null;
	if (!Array.isArray(rows)) return fail("bad_share");
	return {
		success: true,
		shares: rows
			.slice(0, MAX_SHARES)
			.map(toTeamShare)
			.filter((share): share is ReplayTeamShare => share !== null),
	};
}

/** One of the person's own links, with the project it was left with, or null. */
export function toMyTeamShare(raw: unknown): ReplayMyTeamShare | null {
	const share = toTeamShare(raw);
	if (!share || !isRecord(raw)) return null;
	const projectId = raw.project_id;
	if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) return null;
	return { ...share, projectId, projectName: label(raw.project_name, MAX_TITLE) ?? projectId };
}

/** The person's own links, on every project of the server they still reach. */
export async function listMyTeamShares(): Promise<ReplayMyTeamShareListResult> {
	if (!getServerUrl() || !isServerMode()) return fail("not_signed_in");
	const answer = await authedFetch<unknown>("/api/features/replay-shares/mine", "GET");
	if (!answer.ok) return fail(answer.error);
	const rows = isRecord(answer.data) ? answer.data.shares : null;
	if (!Array.isArray(rows)) return fail("bad_share");
	return {
		success: true,
		shares: rows
			.slice(0, MAX_SHARES)
			.map(toMyTeamShare)
			.filter((share): share is ReplayMyTeamShare => share !== null),
	};
}

export async function revokeTeamShare(
	projectId: unknown,
	shareId: unknown,
): Promise<{ success: true } | Failure> {
	const project = getServerProject(projectId);
	if (!project) return fail("not_a_server_project");
	if (typeof shareId !== "string" || !SHARE_ID.test(shareId)) {
		return fail("Invalid share id");
	}
	const answer = await authedFetch<unknown>(
		sharesRoute(project.id, `/${shareId}`),
		"DELETE",
	);
	return answer.ok ? { success: true } : fail(answer.error);
}

/** Open a pasted link: fetch its bundle from this server, import it here. */
export async function openTeamShare(raw: unknown): Promise<ReplayImportResult> {
	const link = parseShareLink(raw);
	if (!link) return fail("not_a_link");
	const serverUrl = getServerUrl();
	if (!serverUrl || !isServerMode()) return fail("not_signed_in");
	if (hostOf(serverUrl) !== link.host) return fail("other_server");
	const project = getServerProject(link.projectId);
	if (!project) return fail("not_a_server_project");
	const answer = await authedFetch<unknown>(
		sharesRoute(project.id, `/${link.shareId}/open`),
		"POST",
		{ token: link.token },
	);
	if (!answer.ok) return fail(answer.error);
	const data = isRecord(answer.data) ? answer.data : {};
	const content = exportedFile(data.content_base64, "wpreplay");
	if (!content) return fail("bad_share");
	return backendFetch<{ session: { session_id: string; agent_name: string } }>(
		"/replay/import",
		{
			method: "POST",
			body: JSON.stringify({ content_base64: content.toString("base64") }),
		},
		TIMEOUT_MS,
	);
}
