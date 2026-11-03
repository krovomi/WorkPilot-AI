/**
 * The person's access tokens for the team server's MCP endpoint (server
 * mode): list, make, revoke (`apps/backend/server/routers/access_tokens.py`).
 *
 * A token is made for the organization the app acts in, and comes back once,
 * in the answer to its creation, with the server's `/mcp` address so the
 * renderer can show what to paste in each AI app. It is not kept here.
 */

import type {
	IPCResult,
	ServerAccessToken,
	ServerAccessTokenCreated,
} from "../shared/types";
import { authedFetch, getServerUrl } from "./server-connection";

const SCOPES: ReadonlySet<string> = new Set(["read", "write"]);
const MAX_NAME = 80;
const MAX_TTL_DAYS = 365;
const TOKEN_ID = /^[0-9a-f-]{36}$/;

interface RawToken {
	id?: unknown;
	name?: unknown;
	prefix?: unknown;
	scope?: unknown;
	created_at?: unknown;
	expires_at?: unknown;
	last_used_at?: unknown;
	token?: unknown;
}

function reason(error: unknown, fallback: string): string {
	return typeof error === "string" && error.length <= 300 ? error : fallback;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function toToken(raw: RawToken): ServerAccessToken {
	return {
		id: text(raw.id),
		name: text(raw.name),
		prefix: text(raw.prefix),
		scope: raw.scope === "write" ? "write" : "read",
		createdAt: text(raw.created_at),
		expiresAt: text(raw.expires_at),
		lastUsedAt: typeof raw.last_used_at === "string" ? raw.last_used_at : null,
	};
}

export function mcpUrl(serverUrl: string): string {
	return `${serverUrl.replace(/\/+$/, "")}/mcp`;
}

export async function listAccessTokens(): Promise<IPCResult<ServerAccessToken[]>> {
	const result = await authedFetch<RawToken[]>("/users/me/access-tokens", "GET");
	if (!result.ok) return { success: false, error: reason(result.error, "Server unavailable") };
	const rows = Array.isArray(result.data) ? result.data : [];
	return { success: true, data: rows.map(toToken) };
}

export async function createAccessToken(
	name: unknown,
	scope: unknown,
	ttlDays: unknown,
): Promise<IPCResult<ServerAccessTokenCreated>> {
	const label = typeof name === "string" ? name.trim() : "";
	if (!label || label.length > MAX_NAME) return { success: false, error: "Invalid name" };
	if (typeof scope !== "string" || !SCOPES.has(scope)) {
		return { success: false, error: "Invalid scope" };
	}
	if (!Number.isInteger(ttlDays) || (ttlDays as number) < 1 || (ttlDays as number) > MAX_TTL_DAYS) {
		return { success: false, error: "Invalid duration" };
	}
	const server = getServerUrl();
	if (!server) return { success: false, error: "No server URL configured" };
	const result = await authedFetch<RawToken>("/users/me/access-tokens", "POST", {
		name: label,
		scope,
		ttl_days: ttlDays,
	});
	if (!result.ok) {
		return { success: false, error: reason(result.error, "The server refused the token") };
	}
	const token = text(result.data?.token);
	if (!token) return { success: false, error: "The server sent no token" };
	return {
		success: true,
		data: { ...toToken(result.data ?? {}), token, mcpUrl: mcpUrl(server) },
	};
}

export async function revokeAccessToken(id: unknown): Promise<IPCResult> {
	if (typeof id !== "string" || !TOKEN_ID.test(id)) {
		return { success: false, error: "Unknown token" };
	}
	const result = await authedFetch(`/users/me/access-tokens/${id}`, "DELETE");
	return result.ok
		? { success: true }
		: { success: false, error: reason(result.error, "Server unavailable") };
}
