/**
 * How the current sign-in was opened, as the server tells it
 * (`GET /auth/me/session`, the caller's own data): the method, the identity
 * provider and when. The app keeps only bounded display fields of a known
 * shape, the same rule as the desktop's `main/server-session-info.ts`: the
 * method from a closed list, the issuer as a host name, a readable date.
 */

export const SIGN_IN_METHODS = ["local", "entra", "oidc", "invite"] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

export interface MySession {
	/** None for a session opened before the server named sign-ins. */
	method: SignInMethod | null;
	providerName: string | null;
	issuerHost: string | null;
	signedInAt: string | null;
}

const HOST = /^[a-z0-9.-]{1,253}$/i;

/** `value` when it is printable text of at most `max` characters, else null. */
function bounded(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!text || text.length > max || /\p{Cc}/u.test(text)) return null;
	return text;
}

/** The display fields of the server's answer, or null when it is not an object. */
export function toMySession(raw: unknown): MySession | null {
	if (!raw || typeof raw !== "object") return null;
	const data = raw as Record<string, unknown>;
	const method = (SIGN_IN_METHODS as readonly unknown[]).includes(data.method) ? (data.method as SignInMethod) : null;
	const host = bounded(data.issuer_host, 253);
	const date = bounded(data.signed_in_at, 64);
	return {
		method,
		providerName: bounded(data.provider_name, 80),
		issuerHost: host && HOST.test(host) ? host : null,
		signedInAt: date && !Number.isNaN(Date.parse(date)) ? date : null,
	};
}
