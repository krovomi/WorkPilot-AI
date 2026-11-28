/**
 * Microsoft Entra ID as one configuration of the OpenID Connect sign-in
 * (`oidc-pkce.ts`): the same Authorization Code + PKCE flow, loopback
 * redirect, `state` and `nonce`, run from the main process.
 *
 * Where a generic provider's endpoints come from its discovery document (the
 * server reads it and describes them in `/auth/config`), Entra's are fixed by
 * its tenant: the server describes the tenant and the client ids, which are
 * checked for their documented shapes here before they are written into a
 * Microsoft URL. The id_token then goes to `/auth/oidc/exchange`, where the
 * server checks it as Entra's (apps/backend/server/auth/oidc.py).
 */

import type { OidcProvider } from "./oidc-pkce";

export const ENTRA_SCOPES = "openid profile email";
const AUTHORITY = "https://login.microsoftonline.com";

export interface EntraConfig {
	entra_tenant_id: string;
	entra_client_id: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A verified domain of the tenant (contoso.onmicrosoft.com, contoso.com).
const TENANT_DOMAIN =
	/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const TENANT_ALIASES = new Set(["common", "organizations", "consumers"]);

/** The ids, or an error naming the one that does not have a valid shape. */
export function checkEntraConfig(config: EntraConfig): EntraConfig {
	const tenant = String(config.entra_tenant_id ?? "").trim();
	const client = String(config.entra_client_id ?? "").trim();
	const tenantOk =
		GUID.test(tenant) ||
		TENANT_DOMAIN.test(tenant) ||
		TENANT_ALIASES.has(tenant.toLowerCase());
	if (!tenantOk) {
		throw new Error("The server's Entra ID tenant is not a valid tenant id");
	}
	if (!GUID.test(client)) {
		throw new Error("The server's Entra ID client is not a valid client id");
	}
	return { entra_tenant_id: tenant, entra_client_id: client };
}

/** The tenant's endpoints and the client, for the OpenID Connect sign-in. */
export function entraProvider(rawConfig: EntraConfig): OidcProvider {
	const config = checkEntraConfig(rawConfig);
	const base = `${AUTHORITY}/${encodeURIComponent(config.entra_tenant_id)}/oauth2/v2.0`;
	return {
		authorizationEndpoint: `${base}/authorize`,
		tokenEndpoint: `${base}/token`,
		clientId: config.entra_client_id,
		scopes: ENTRA_SCOPES,
	};
}

/**
 * The Entra provider the server describes in `/auth/config`; null when the
 * server offers none, an error when the ids it gives have no valid shape.
 */
export function entraProviderFromConfig(config: unknown): OidcProvider | null {
	if (!config || typeof config !== "object") return null;
	const data = config as Record<string, unknown>;
	if (data.entra_enabled !== true) return null;
	return entraProvider({
		entra_tenant_id: data.entra_tenant_id as string,
		entra_client_id: data.entra_client_id as string,
	});
}
