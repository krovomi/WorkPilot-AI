/**
 * A server card's approval and a server project's lent approvals (server
 * mode), for the Spec Approval view.
 *
 * The server decides who approves, how many, and who may lend their approval
 * (`apps/backend/shared_board/approvals.py`): this module only asks it, by a
 * project id and a card id, and reads its answers field by field, so nothing
 * else of an answer reaches the renderer. The arguments come from the
 * renderer and are checked again here (`server-approval-handlers.ts`).
 */

import type { IPCResult, Project } from "../shared/types";
import {
	SERVER_CRITICALITIES,
	type ServerApprovalEntry,
	type ServerCardApproval,
	type ServerCriticality,
	type ServerCriticalitySource,
	type ServerDelegation,
	type ServerDelegationInput,
	type ServerPerson,
} from "../shared/types/server-approval";
import type { ServerCard } from "./server-board-actions";
import { authedFetch, getAuthState } from "./server-connection";

const MAX_TEXT = 200;
const MAX_ITEMS = 50;
const SOURCES = new Set<ServerCriticalitySource>(["set", "assessed", "default"]);
const UNEXPECTED = "Unexpected answer from the server";

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value.slice(0, MAX_TEXT) : "";
}

function count(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
		? value
		: fallback;
}

function slugs(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((s): s is string => typeof s === "string").map((s) => s.slice(0, 80)).slice(0, 10)
		: [];
}

export function isCriticality(value: unknown): value is ServerCriticality {
	return SERVER_CRITICALITIES.includes(value as ServerCriticality);
}

function entry(raw: unknown): ServerApprovalEntry {
	const item = record(raw);
	return {
		by: text(item.by),
		for: typeof item.for === "string" ? text(item.for) : null,
		at: text(item.at),
		roles: slugs(item.roles),
	};
}

/** The server's answer on a card's approval, or null when it is not one. */
export function parseApproval(data: unknown): ServerCardApproval | null {
	const raw = record(data);
	if (!isCriticality(raw.criticality)) return null;
	const source = raw.criticalitySource as ServerCriticalitySource;
	return {
		criticality: raw.criticality,
		criticalitySource: SOURCES.has(source) ? source : "default",
		needed: count(raw.needed, 1),
		count: count(raw.count, 0),
		roles: slugs(raw.roles),
		missingRoles: slugs(raw.missingRoles),
		approvals: Array.isArray(raw.approvals) ? raw.approvals.slice(0, MAX_ITEMS).map(entry) : [],
		complete: raw.complete === true,
		approved: raw.approved === true,
	};
}

function person(raw: unknown): ServerPerson | null {
	const item = record(raw);
	const id = text(item.id);
	return id ? { id, name: text(item.name) || id } : null;
}

/** One delegation from the server's answer, or null. */
export function parseDelegation(raw: unknown): ServerDelegation | null {
	const item = record(raw);
	const from = person(item.from);
	const to = person(item.to);
	const id = text(item.id);
	if (!id || !from || !to) return null;
	return {
		id,
		from,
		to,
		startsAt: text(item.startsAt),
		endsAt: text(item.endsAt),
		active: item.active === true,
	};
}

function cardUrl(card: ServerCard, action: string): string {
	return `/api/board/cards/${encodeURIComponent(card.cardId)}/${action}?project_id=${encodeURIComponent(card.project.id)}`;
}

function delegationsUrl(project: Project, id?: string): string {
	const tail = id ? `/${encodeURIComponent(id)}` : "";
	return `/api/board/delegations${tail}?project_id=${encodeURIComponent(project.id)}`;
}

async function approvalCall(
	card: ServerCard,
	method: "GET" | "PUT",
	action: string,
	body?: unknown,
): Promise<IPCResult<ServerCardApproval>> {
	const result = await authedFetch<unknown>(cardUrl(card, action), method, body);
	if (!result.ok) return { success: false, error: result.error };
	const parsed = parseApproval(result.data);
	return parsed ? { success: true, data: parsed } : { success: false, error: UNEXPECTED };
}

/** Where the card's approval stands: its criticality, who approved, what is missing. */
export function getServerCardApproval(card: ServerCard): Promise<IPCResult<ServerCardApproval>> {
	return approvalCall(card, "GET", "approvals");
}

/** Say how critical the card is; the server answers with its approval as it now stands. */
export function setServerCardCriticality(
	card: ServerCard,
	criticality: ServerCriticality,
): Promise<IPCResult<ServerCardApproval>> {
	return approvalCall(card, "PUT", "criticality", { criticality });
}

/** The approvals lent on the project, running or to come. */
export async function listServerDelegations(
	project: Project,
): Promise<IPCResult<ServerDelegation[]>> {
	const result = await authedFetch<unknown>(delegationsUrl(project), "GET");
	if (!result.ok) return { success: false, error: result.error };
	if (!Array.isArray(result.data)) return { success: false, error: UNEXPECTED };
	return {
		success: true,
		data: result.data
			.slice(0, MAX_ITEMS)
			.map(parseDelegation)
			.filter((d): d is ServerDelegation => d !== null),
	};
}

/** Lend one's approval on the project to a colleague, for a while. */
export async function createServerDelegation(
	project: Project,
	input: ServerDelegationInput,
): Promise<IPCResult<ServerDelegation>> {
	const body: Record<string, string> = { to_user_id: input.toUserId, ends_at: input.endsAt };
	if (input.startsAt) body.starts_at = input.startsAt;
	const result = await authedFetch<unknown>(delegationsUrl(project), "POST", body);
	if (!result.ok) return { success: false, error: result.error };
	const parsed = parseDelegation(result.data);
	return parsed ? { success: true, data: parsed } : { success: false, error: UNEXPECTED };
}

/** End a lent approval now. */
export async function revokeServerDelegation(
	project: Project,
	delegationId: string,
): Promise<IPCResult<void>> {
	const result = await authedFetch<unknown>(delegationsUrl(project, delegationId), "DELETE");
	return result.ok ? { success: true } : { success: false, error: result.error };
}

/**
 * The project's members who can change a card, other than the person signed
 * in: those an approval may be lent to (the server checks them again).
 */
export async function listServerDelegates(project: Project): Promise<IPCResult<ServerPerson[]>> {
	const result = await authedFetch<unknown>(
		`/projects/${encodeURIComponent(project.id)}/members`,
		"GET",
	);
	if (!result.ok) return { success: false, error: result.error };
	if (!Array.isArray(result.data)) return { success: false, error: UNEXPECTED };
	const me = getAuthState().user?.id;
	const people: ServerPerson[] = [];
	for (const raw of result.data.slice(0, 500)) {
		const member = record(raw);
		const id = text(member.user_id);
		if (!id || id === me || (member.role !== "member" && member.role !== "owner")) continue;
		people.push({ id, name: text(member.display_name) || text(member.email) || id });
	}
	return { success: true, data: people };
}
