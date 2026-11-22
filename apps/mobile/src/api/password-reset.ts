/**
 * A forgotten password, from the phone: ask the server for a reset link, then
 * set the new password with the link (or the code it carries).
 *
 * These routes are public: they run before anyone is signed in. The server
 * answers a request the same way whether the address has an account or not,
 * and only emails a link when it can send email (`password_reset_by_email`).
 */
import type { ServerClient } from "./client";

/** A reset token: what the server puts after `?token=` in the link. */
const TOKEN = /^[A-Za-z0-9_-]{16,200}$/;

/** The token of a pasted link, or of a bare code; null when it is neither. */
export function tokenOf(input: string): string | null {
	const text = input.trim();
	if (TOKEN.test(text)) return text;
	const match = /[?&]token=([^&#\s]+)/.exec(text);
	return match && TOKEN.test(match[1]) ? match[1] : null;
}

export function passwordReset(client: ServerClient) {
	return {
		request: (email: string) =>
			client.publicRequest<{ requested: boolean }>("POST", "/auth/password-reset/request", { email }),
		confirm: (token: string, newPassword: string) =>
			client.publicRequest<{ reset: boolean }>("POST", "/auth/password-reset/confirm", {
				token,
				new_password: newPassword,
			}),
	};
}
