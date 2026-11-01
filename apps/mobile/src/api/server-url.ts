/**
 * The address of a WorkPilot server, as a person types it on the phone.
 *
 * The phone sends a password and then bearer tokens to this address, so it
 * must be HTTPS. Plain HTTP is accepted only for a server on the same
 * machine or the local network (a developer's laptop, an office box), where
 * there is no certificate to get; iOS and Android refuse cleartext to any
 * other host anyway.
 */

export type ServerUrlResult = { ok: true; url: string } | { ok: false; reason: "invalid" | "insecure" };

const PRIVATE_V4 = [
	/^127\./,
	/^10\./,
	/^192\.168\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^169\.254\./,
];
// 10.0.2.2, the Android emulator's view of its host, is in 10/8.

/** Whether a host name is this machine or the local network. */
export function isLocalHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
	// A private range only counts on an IPv4 literal: "10.example.com" is a public name.
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
	return PRIVATE_V4.some((range) => range.test(host));
}

/** The server's base URL, without a trailing slash, or why it is refused. */
export function normaliseServerUrl(input: string): ServerUrlResult {
	let text = input.trim();
	if (!text) return { ok: false, reason: "invalid" };
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return { ok: false, reason: "invalid" };
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "invalid" };
	if (!url.hostname || url.username || url.password || url.search || url.hash) {
		return { ok: false, reason: "invalid" };
	}
	if (url.protocol === "http:" && !isLocalHost(url.hostname)) return { ok: false, reason: "insecure" };
	const path = url.pathname.replace(/\/+$/, "");
	return { ok: true, url: `${url.protocol}//${url.host}${path}` };
}

/** The port the stream listens on when the server names no other address. */
export const DEFAULT_STREAM_PORT = 8765;

/**
 * The live stream's base URL: the one the server advertises
 * (`GET /api/board/stream`), else the API's host on the stream's port, `wss`
 * behind `https`. Same rule as the desktop (`server-project-stream.ts`).
 */
export function streamBase(serverUrl: string, advertised: unknown): string | null {
	if (typeof advertised === "string" && /^wss?:\/\/[^\s]+$/.test(advertised)) {
		return advertised.replace(/\/+$/, "");
	}
	try {
		const api = new URL(serverUrl);
		if (api.protocol !== "http:" && api.protocol !== "https:") return null;
		const scheme = api.protocol === "https:" ? "wss:" : "ws:";
		return `${scheme}//${api.hostname}:${DEFAULT_STREAM_PORT}`;
	} catch {
		return null;
	}
}
