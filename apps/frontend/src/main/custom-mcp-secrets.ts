/**
 * The header and environment values of a project's custom MCP servers, as the
 * renderer may see them and as it sends them back.
 *
 * They hold API keys and bearer tokens, so the renderer gets the mask in their
 * place (rule S6). A bearer `Authorization` header keeps its scheme, so the
 * server dialog still shows a token field. A value sent back as the mask keeps
 * its stored value, and only for the same server at the same URL or command:
 * a token never goes to an endpoint the renderer names.
 */
import { MASKED_SECRET } from "../shared/constants";
import type { CustomMcpServer } from "../shared/types";
import { sameEndpoint, unmaskSecret } from "./utils/masked-secret";

const BEARER = /^bearer /i;

type Values = Record<string, string> | undefined;

function maskValue(value: unknown): string {
	if (typeof value !== "string") return MASKED_SECRET;
	if (BEARER.test(value)) return `${value.slice(0, 7)}${MASKED_SECRET}`;
	return value && MASKED_SECRET;
}

function maskValues(values: Values): Values {
	if (typeof values !== "object" || values === null) return undefined;
	return Object.fromEntries(
		Object.entries(values).map(([key, value]) => [key, maskValue(value)]),
	);
}

/** `servers` as the renderer may see them. */
export function maskCustomMcpServers(
	servers: CustomMcpServer[],
): CustomMcpServer[] {
	return servers.map((server) => ({
		...server,
		...(server.headers && { headers: maskValues(server.headers) }),
		...(server.env && { env: maskValues(server.env) }),
	}));
}

function sameProgram(a: CustomMcpServer, b: CustomMcpServer): boolean {
	if (a.type !== b.type) return false;
	if (a.type === "http") return sameEndpoint(a.url, b.url);
	const args = (server: CustomMcpServer) =>
		Array.isArray(server.args) ? JSON.stringify(server.args) : "[]";
	return a.command === b.command && args(a) === args(b);
}

function restoreValues(sent: Values, stored: Values): Values {
	if (typeof sent !== "object" || sent === null) return undefined;
	const restored: Record<string, string> = {};
	for (const [key, value] of Object.entries(sent)) {
		// Header and environment values are text; anything else is not written.
		if (typeof value !== "string") continue;
		const scheme = BEARER.exec(value)?.[0] ?? "";
		const secret = value.slice(scheme.length);
		const typed = unmaskSecret(secret);
		if (typed === secret) restored[key] = value;
		else if (typed !== undefined) restored[key] = scheme + typed;
		else if (typeof stored?.[key] === "string") restored[key] = stored[key];
		// A mask with nothing stored behind it is left out, never written.
	}
	return restored;
}

/**
 * `sent` with each masked value replaced by the stored one of the same
 * server (same id, same URL or command); a masked value without one is left
 * out.
 */
export function unmaskCustomMcpServers(
	sent: CustomMcpServer[],
	stored: CustomMcpServer[],
): CustomMcpServer[] {
	return sent.map((server) => {
		const previous = stored.find(
			(candidate) =>
				candidate.id === server.id && sameProgram(candidate, server),
		);
		return {
			...server,
			...(server.headers && {
				headers: restoreValues(server.headers, previous?.headers),
			}),
			...(server.env && { env: restoreValues(server.env, previous?.env) }),
		};
	});
}

/** The servers of a stored `CUSTOM_MCP_SERVERS` value; `[]` when unreadable. */
export function parseCustomMcpServers(
	raw: string | undefined,
): CustomMcpServer[] {
	if (!raw) return [];
	try {
		const servers: unknown = JSON.parse(raw);
		return Array.isArray(servers) ? (servers as CustomMcpServer[]) : [];
	} catch {
		return [];
	}
}
