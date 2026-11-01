/**
 * Microsoft Entra sign-in: the system browser opens Microsoft's page for the
 * server's own app registration (`/auth/config` names its tenant and client),
 * the app gets an authorization code back on `workpilot://auth` (PKCE, no
 * secret on the phone), trades it with Microsoft for an id_token and hands
 * that to the server, which checks its signature, audience and issuer
 * (`POST /auth/oidc/exchange`). The redirect URI must be registered on the
 * Entra app as a "Mobile and desktop applications" platform.
 */

import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import type { AuthConfig } from "../api/types";

// On the web build, the page Microsoft sends back to closes the popup.
WebBrowser.maybeCompleteAuthSession();

export const ENTRA_SCOPES = ["openid", "profile", "email"];

/** Microsoft's v2.0 issuer for a tenant; a tenant that is not a plain id or domain is refused. */
export function entraIssuer(tenantId: string): string {
	if (!/^[A-Za-z0-9.-]{1,128}$/.test(tenantId)) throw new Error("entra_misconfigured");
	return `https://login.microsoftonline.com/${tenantId}/v2.0`;
}

export function entraRedirectUri(): string {
	return AuthSession.makeRedirectUri({ scheme: "workpilot", path: "auth" });
}

/**
 * The id_token of the person's Microsoft account, or null when they closed
 * the page. Throws `entra_disabled` when the server offers no Entra sign-in.
 */
export async function entraIdToken(config: AuthConfig): Promise<string | null> {
	if (!config.entra_enabled || !config.entra_tenant_id || !config.entra_client_id) {
		throw new Error("entra_disabled");
	}
	const clientId = config.entra_client_id;
	const discovery = await AuthSession.fetchDiscoveryAsync(entraIssuer(config.entra_tenant_id));
	const redirectUri = entraRedirectUri();
	const request = new AuthSession.AuthRequest({
		clientId,
		redirectUri,
		scopes: ENTRA_SCOPES,
		responseType: AuthSession.ResponseType.Code,
		usePKCE: true,
		prompt: AuthSession.Prompt.SelectAccount,
	});
	const result = await request.promptAsync(discovery);
	if (result.type !== "success") {
		if (result.type === "error") throw new Error(result.error?.description || "entra_failed");
		return null;
	}
	const tokens = await AuthSession.exchangeCodeAsync(
		{
			clientId,
			redirectUri,
			code: result.params.code,
			extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : undefined,
		},
		discovery,
	);
	if (!tokens.idToken) throw new Error("entra_failed");
	return tokens.idToken;
}
