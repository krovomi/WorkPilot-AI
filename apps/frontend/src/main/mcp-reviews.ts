/**
 * The organization's security reviews of a catalogue MCP server, from a
 * server project (#369, lots 5 and 6): read them, write one's own, delete one.
 *
 * The server keeps them with the project's organization
 * (`apps/backend/shared_features/mcp_reviews.py`) and checks every
 * permission; main only talks to it for a project the app
 * listed from that server (`getServerProject`). The renderer gives a project
 * id, a catalogue id, a verdict from a closed list and a comment, or a
 * review id: each is checked here before a request is made, and what the
 * server answers is read back field by field.
 */

import type { IPCResult } from "../shared/types/common";
import {
	MCP_REVIEW_MAX_COMMENT,
	MCP_REVIEW_VERDICTS,
	type McpReviewList,
	type McpReviewVerdict,
	type McpServerReview,
} from "../shared/types/mcp-reviews";
import { authedFetch, isServerMode } from "./server-connection";
import { getServerProject } from "./server-projects";

/** A catalogue id, as the server and the install policy name one. */
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REVIEW_ID = /^[0-9a-f-]{36}$/;
const MAX_REVIEWS = 500;
const MAX_TEXT = 200;
const VERDICTS = new Set<string>(MCP_REVIEW_VERDICTS);

const fail = <T>(error: string): IPCResult<T> => ({ success: false, error });

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serverProjectId(projectId: unknown): string | null {
	if (!isServerMode()) return null;
	return getServerProject(projectId)?.id ?? null;
}

const route = (projectId: string, tail = "", serverId?: string) =>
	`/api/features/mcp-reviews${tail}?project_id=${encodeURIComponent(projectId)}${
		serverId ? `&server_id=${encodeURIComponent(serverId)}` : ""
	}`;

/** A review as the server answered it, or null when it is not one. */
export function toReview(raw: unknown): McpServerReview | null {
	if (!isRecord(raw)) return null;
	const { id, server_id, verdict, comment, author, updated_at } = raw;
	if (typeof id !== "string" || !REVIEW_ID.test(id)) return null;
	if (typeof server_id !== "string" || !SERVER_ID.test(server_id)) return null;
	if (typeof verdict !== "string" || !VERDICTS.has(verdict)) return null;
	return {
		id,
		serverId: server_id,
		verdict: verdict as McpReviewVerdict,
		comment: typeof comment === "string" ? comment.slice(0, MCP_REVIEW_MAX_COMMENT) : "",
		author: typeof author === "string" ? author.slice(0, MAX_TEXT) : "",
		updatedAt: typeof updated_at === "string" ? updated_at.slice(0, 40) : null,
		mine: raw.mine === true,
		canDelete: raw.can_delete === true,
	};
}

/**
 * The reviews of `serverId` in the organization of the server project
 * `projectId`, the latest first, and whether the server lets the caller write.
 */
export async function listMcpReviews(request: unknown): Promise<IPCResult<McpReviewList>> {
	if (!isRecord(request)) return fail("Invalid request");
	const projectId = serverProjectId(request.projectId);
	if (!projectId) return fail("not_a_server_project");
	const { serverId } = request;
	if (typeof serverId !== "string" || !SERVER_ID.test(serverId)) {
		return fail("Invalid server id");
	}
	const answer = await authedFetch<unknown>(route(projectId, "", serverId), "GET");
	if (!answer.ok) return fail(answer.error);
	const body = isRecord(answer.data) ? answer.data : null;
	if (!body || !Array.isArray(body.reviews)) return fail("bad_reviews");
	return {
		success: true,
		data: {
			reviews: body.reviews
				.slice(0, MAX_REVIEWS)
				.map(toReview)
				.filter((review): review is McpServerReview => review !== null),
			canWrite: body.can_write === true,
		},
	};
}

/** Write the caller's review of a server, replacing the one they left. */
export async function putMcpReview(request: unknown): Promise<IPCResult<McpServerReview>> {
	if (!isRecord(request)) return fail("Invalid request");
	const projectId = serverProjectId(request.projectId);
	if (!projectId) return fail("not_a_server_project");
	const { serverId, verdict, comment } = request;
	if (typeof serverId !== "string" || !SERVER_ID.test(serverId)) {
		return fail("Invalid server id");
	}
	if (typeof verdict !== "string" || !VERDICTS.has(verdict)) return fail("Invalid verdict");
	if (typeof comment !== "string" || comment.length > MCP_REVIEW_MAX_COMMENT) {
		return fail("Invalid comment");
	}
	const answer = await authedFetch<unknown>(route(projectId), "PUT", {
		server_id: serverId,
		verdict,
		comment,
	});
	if (!answer.ok) return fail(answer.error);
	const review = toReview(isRecord(answer.data) ? answer.data.review : null);
	return review ? { success: true, data: review } : fail("bad_reviews");
}

/** Delete a review: the server lets its author or an organization administrator do it. */
export async function deleteMcpReview(request: unknown): Promise<IPCResult<boolean>> {
	if (!isRecord(request)) return fail("Invalid request");
	const projectId = serverProjectId(request.projectId);
	if (!projectId) return fail("not_a_server_project");
	const { reviewId } = request;
	if (typeof reviewId !== "string" || !REVIEW_ID.test(reviewId)) {
		return fail("Invalid review id");
	}
	const answer = await authedFetch<unknown>(route(projectId, `/${reviewId}`), "DELETE");
	return answer.ok ? { success: true, data: true } : fail(answer.error);
}
