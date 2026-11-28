/**
 * Sign-in with the server's OpenID Connect provider (Okta, Google, Keycloak,
 * Auth0…): `/auth/config` names its endpoints, which the server read from
 * the provider's discovery document and checked. The phone runs the same
 * browser flow as for Entra (`code-flow.ts`) and hands the id_token to
 * `POST /auth/sso/exchange`, which verifies it. The provider's client must
 * list `workpilot://auth` among its redirect URIs.
 *
 * `/auth/config` is a network answer: every address, the client id and the
 * scopes are checked again here before the browser opens, as the desktop's
 * `providerFromConfig` does (`oidc-pkce.ts`).
 */

import type { AuthConfig } from "../api/types";
import { codeFlowIdToken } from "./code-flow";

// Plain http only for a provider on this very machine (a development Keycloak).
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CLIENT_ID = /^[\x21-\x7E]{1,200}$/;
// A scope token as RFC 6749 (section 3.3) spells it.
const SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]{1,100}$/;

export interface SsoProvider {
	authorizationEndpoint: string;
	tokenEndpoint: string;
	clientId: string;
	scopes: string[];
}

/** `raw` when it is an https URL (http on loopback), with no credentials or fragment. */
export function endpointUrl(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.length > 2000) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
	if (!secure || url.username || url.password || url.hash) return null;
	return raw;
}

/** The provider the server describes, or null when it offers none or any part is unusable. */
export function ssoProvider(config: AuthConfig): SsoProvider | null {
	if (config.sso_enabled !== true) return null;
	const authorizationEndpoint = endpointUrl(config.sso_authorization_endpoint);
	const tokenEndpoint = endpointUrl(config.sso_token_endpoint);
	const clientId = config.sso_client_id;
	const scopes = typeof config.sso_scopes === "string" ? config.sso_scopes.split(" ") : [];
	if (
		!authorizationEndpoint ||
		!tokenEndpoint ||
		typeof clientId !== "string" ||
		!CLIENT_ID.test(clientId) ||
		!scopes.includes("openid") ||
		scopes.length > 20 ||
		!scopes.every((s) => SCOPE.test(s))
	) {
		return null;
	}
	return { authorizationEndpoint, tokenEndpoint, clientId, scopes };
}

/**
 * The id_token of the person's account at the provider, or null when they
 * closed the page. Throws `sso_disabled` when the server offers no usable one.
 */
export async function ssoIdToken(config: AuthConfig): Promise<string | null> {
	const provider = ssoProvider(config);
	if (!provider) throw new Error("sso_disabled");
	return codeFlowIdToken({
		discovery: { authorizationEndpoint: provider.authorizationEndpoint, tokenEndpoint: provider.tokenEndpoint },
		clientId: provider.clientId,
		scopes: provider.scopes,
		failure: "sso_failed",
	});
}
