/**
 * Microsoft Entra sign-in: the system browser opens Microsoft's page for the
 * server's own app registration (`/auth/config` names its tenant and client),
 * the app gets an authorization code back on `workpilot://auth` (PKCE, no
 * secret on the phone), trades it with Microsoft for an id_token and hands
 * that to the server, which checks its signature, audience and issuer
 * (`POST /auth/oidc/exchange`). The redirect URI must be registered on the
 * Entra app as a "Mobile and desktop applications" platform. The flow itself
 * (`state`, `nonce`) is the one every provider shares: `code-flow.ts`.
 */

import * as AuthSession from "expo-auth-session";
import type { AuthConfig } from "../api/types";
import { appRedirectUri, codeFlowIdToken } from "./code-flow";

export const ENTRA_SCOPES = ["openid", "profile", "email"];

/** Microsoft's v2.0 issuer for a tenant; a tenant that is not a plain id or domain is refused. */
export function entraIssuer(tenantId: string): string {
	if (!/^[A-Za-z0-9.-]{1,128}$/.test(tenantId)) throw new Error("entra_misconfigured");
	return `https://login.microsoftonline.com/${tenantId}/v2.0`;
}

export function entraRedirectUri(): string {
	return appRedirectUri();
}

/**
 * The id_token of the person's Microsoft account, or null when they closed
 * the page. Throws `entra_disabled` when the server offers no Entra sign-in.
 */
export async function entraIdToken(config: AuthConfig): Promise<string | null> {
	if (!config.entra_enabled || !config.entra_tenant_id || !config.entra_client_id) {
		throw new Error("entra_disabled");
	}
	return codeFlowIdToken({
		discovery: await AuthSession.fetchDiscoveryAsync(entraIssuer(config.entra_tenant_id)),
		clientId: config.entra_client_id,
		scopes: ENTRA_SCOPES,
		prompt: AuthSession.Prompt.SelectAccount,
		failure: "entra_failed",
	});
}
