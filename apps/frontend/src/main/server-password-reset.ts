/**
 * A forgotten server password: ask for a link, read it, set a new password,
 * and the platform admin's "issue a link for this account".
 *
 * The renderer is not trusted (rule S6): every argument is checked here
 * before a request leaves, with the bounds the server applies. The three
 * public calls go to the address the person typed on the sign-in screen, as
 * a sign-in does; the admin call goes to the connected server with the
 * session's token. No token or password is logged.
 */

import { authedFetch } from "./server-connection";

export type ResetResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface PasswordResetIssued {
	email: string;
	expires_at: string;
	email_sent: boolean;
	/** Only when no email went: the admin hands the link over. */
	reset_link: string | null;
}

const MAX_URL = 2000;
const MAX_EMAIL = 320;
const TOKEN = /^[A-Za-z0-9_-]{16,200}$/;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 1024;
const USER_ID = /^[A-Za-z0-9-]{1,64}$/;

function refused<T>(error: string): ResetResult<T> {
	return { ok: false, error };
}

/** The server's base URL (http or https, no credentials), or null. */
export function serverBase(raw: unknown): string | null {
	if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_URL) return null;
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	if (url.username || url.password || url.search || url.hash) return null;
	return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** The token of a pasted link (…/reset-password?token=…) or a bare token. */
export function tokenOf(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	let value = raw.trim();
	try {
		const fromQuery = new URL(value).searchParams.get("token");
		if (fromQuery) value = fromQuery;
	} catch {
		// not a URL: a bare token
	}
	return TOKEN.test(value) ? value : null;
}

async function post<T>(base: string, path: string, body: unknown): Promise<ResetResult<T>> {
	try {
		const res = await fetch(`${base}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const text = await res.text();
		if (!res.ok) {
			let detail: unknown;
			try {
				detail = (JSON.parse(text) as { detail?: unknown }).detail;
			} catch {
				detail = undefined;
			}
			return refused(typeof detail === "string" ? detail : `HTTP ${res.status}`);
		}
		return { ok: true, data: JSON.parse(text) as T };
	} catch (err) {
		return refused(err instanceof Error ? err.message : String(err));
	}
}

/** Ask for a link by email; the server answers the same for any address. */
export async function requestPasswordReset(
	serverUrl: unknown,
	email: unknown,
): Promise<ResetResult<{ requested: boolean }>> {
	const base = serverBase(serverUrl);
	if (!base) return refused("Invalid server address");
	if (typeof email !== "string" || !email.includes("@") || email.length > MAX_EMAIL) {
		return refused("Invalid email address");
	}
	return post(base, "/auth/password-reset/request", { email: email.trim() });
}

/** The address a link is for, before choosing the new password. */
export async function lookupPasswordReset(
	serverUrl: unknown,
	link: unknown,
): Promise<ResetResult<{ email: string }>> {
	const base = serverBase(serverUrl);
	if (!base) return refused("Invalid server address");
	const token = tokenOf(link);
	if (!token) return refused("Invalid reset link");
	return post(base, "/auth/password-reset/lookup", { token });
}

/** Set the new password with the link; every session of the account ends. */
export async function confirmPasswordReset(
	serverUrl: unknown,
	link: unknown,
	password: unknown,
): Promise<ResetResult<{ reset: boolean }>> {
	const base = serverBase(serverUrl);
	if (!base) return refused("Invalid server address");
	const token = tokenOf(link);
	if (!token) return refused("Invalid reset link");
	if (
		typeof password !== "string" ||
		password.length < MIN_PASSWORD ||
		password.length > MAX_PASSWORD
	) {
		return refused("Invalid password");
	}
	return post(base, "/auth/password-reset/confirm", { token, new_password: password });
}

/** Platform admin: a link for the account ``userId`` of the connected server. */
export async function issuePasswordReset(
	userId: unknown,
): Promise<ResetResult<PasswordResetIssued>> {
	if (typeof userId !== "string" || !USER_ID.test(userId)) {
		return refused("Invalid user id");
	}
	return authedFetch<PasswordResetIssued>(
		`/admin/users/${encodeURIComponent(userId)}/password-reset`,
		"POST",
	);
}
