/**
 * How the current server session was opened (server mode): the server tells
 * it (`GET /auth/me/session`, the caller's own data) and this module keeps,
 * for the renderer, only bounded display fields of a known shape. No token
 * leaves the main: the renderer gets names, an email, a host and a date.
 */

import type { IPCResult } from "../shared/types";
import type {
	ServerSessionInfo,
	ServerSignInMethod,
} from "../shared/types/server-session";
import { authedFetch, getServerUrl } from "./server-connection";

const METHODS: ReadonlySet<string> = new Set<ServerSignInMethod>([
	"local",
	"entra",
	"oidc",
	"invite",
]);
const HOST = /^[a-z0-9.-]{1,253}$/i;

interface RawSession {
	user?: { email?: unknown; display_name?: unknown; role?: unknown } | null;
	method?: unknown;
	provider_name?: unknown;
	issuer_host?: unknown;
	signed_in_at?: unknown;
}

/** `value` when it is printable text of at most `max` characters, else null. */
function bounded(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!text || text.length > max || /[\p{Cc}]/u.test(text)) return null;
	return text;
}

function dateTime(value: unknown): string | null {
	const text = bounded(value, 64);
	return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

/** The session's display fields, or null when the answer has no usable person. */
export function toSessionInfo(
	serverUrl: string,
	raw: unknown,
): ServerSessionInfo | null {
	if (!raw || typeof raw !== "object") return null;
	const data = raw as RawSession;
	const email = bounded(data.user?.email, 320);
	if (!email) return null;
	const method =
		typeof data.method === "string" && METHODS.has(data.method)
			? (data.method as ServerSignInMethod)
			: null;
	const host = bounded(data.issuer_host, 253);
	return {
		serverUrl,
		user: {
			email,
			displayName: bounded(data.user?.display_name, 200) ?? email,
			role: bounded(data.user?.role, 40) ?? "",
		},
		method,
		providerName: bounded(data.provider_name, 80),
		issuerHost: host && HOST.test(host) ? host : null,
		signedInAt: dateTime(data.signed_in_at),
	};
}

export async function getServerSession(): Promise<IPCResult<ServerSessionInfo>> {
	const serverUrl = getServerUrl();
	if (!serverUrl) return { success: false, error: "No server URL configured" };
	const result = await authedFetch<unknown>("/auth/me/session", "GET");
	if (!result.ok) {
		const error =
			typeof result.error === "string" && result.error.length <= 300
				? result.error
				: "Server unavailable";
		return { success: false, error };
	}
	const info = toSessionInfo(serverUrl, result.data);
	if (!info) return { success: false, error: "The server's answer is not usable" };
	return { success: true, data: info };
}
