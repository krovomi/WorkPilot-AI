/**
 * The authentication pieces of an API Explorer request: the Basic header, the
 * token a sign-in answer holds, and the OAuth 2.0 token request. The token
 * request goes through the main process like every other request: the
 * renderer's CSP lets it reach no other host.
 */
import type { RequestAuth } from "../../stores/api-explorer-store";

/** Where a sign-in answer usually puts its token, most common first. */
export const TOKEN_FIELDS = [
	"access_token",
	"token",
	"jwt",
	"auth_token",
	"id_token",
	"bearer_token",
	"accessToken",
	"authToken",
	"idToken",
] as const;

/** `Basic` credentials, encoded as UTF-8 first: `btoa` alone refuses "é". */
export function basicAuthHeader(username: string, password: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(`${username}:${password}`)) {
		binary += String.fromCharCode(byte);
	}
	return `Basic ${btoa(binary)}`;
}

function readJsonObject(body: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(body);
		return value && typeof value === "object"
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** The token of a successful answer, when it has one long enough to be one. */
export function findResponseToken(
	body: string,
	status: number | null,
): string | null {
	if (!body || !status || status < 200 || status >= 300) return null;
	const json = readJsonObject(body);
	if (!json) return null;
	for (const field of TOKEN_FIELDS) {
		const value = json[field];
		if (typeof value === "string" && value.length > 10) return value;
	}
	return null;
}

/**
 * Asks the token endpoint for an access token (client credentials or
 * password grant). Gives the token, or the error the endpoint or the request
 * named; `null` when neither named one.
 */
export async function requestOAuth2Token(
	auth: RequestAuth,
): Promise<{ token: string } | { error: string | null }> {
	const form = new URLSearchParams({ grant_type: auth.oauth2GrantType });
	if (auth.oauth2ClientId) form.append("client_id", auth.oauth2ClientId);
	if (auth.oauth2ClientSecret)
		form.append("client_secret", auth.oauth2ClientSecret);
	if (auth.oauth2Scope) form.append("scope", auth.oauth2Scope);
	if (auth.oauth2GrantType === "password") {
		form.append("username", auth.username);
		form.append("password", auth.password);
	}

	const result = await globalThis.electronAPI.proxyHttpRequest({
		url: auth.oauth2TokenUrl,
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: form.toString(),
	});
	const data = readJsonObject(result.body ?? "") ?? {};
	if (typeof data.access_token === "string") return { token: data.access_token };
	if (typeof data.error_description === "string")
		return { error: data.error_description };
	if (typeof data.error === "string") return { error: data.error };
	return { error: result.error ?? null };
}
