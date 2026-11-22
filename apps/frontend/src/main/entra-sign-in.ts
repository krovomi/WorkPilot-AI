/**
 * Microsoft Entra ID sign-in for server mode: the public-client
 * Authorization Code + PKCE flow, run from the main process.
 *
 * System browser -> loopback redirect -> token exchange -> id_token handed
 * to the WorkPilot server, which answers with its own JWT pair (see
 * apps/backend/server/auth/oidc.py).
 *
 * The tenant and client ids come from the server's public configuration:
 * they are checked for their documented shapes before they are written
 * into a Microsoft URL, the request carries a nonce that the returned
 * id_token must echo, and the browser is opened through `openExternalUrl`
 * like every other link of the app.
 */

import * as crypto from "node:crypto";
import * as http from "node:http";
import { openExternalUrl } from "./open-external";

export const ENTRA_SCOPES = "openid profile email";
export const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;
const AUTHORITY = "https://login.microsoftonline.com";

export interface EntraConfig {
	entra_tenant_id: string;
	entra_client_id: string;
}

export interface EntraDeps {
	openBrowser: (url: string) => Promise<void>;
	fetch: typeof fetch;
	timeoutMs: number;
}

const defaultDeps: EntraDeps = {
	openBrowser: (url) => openExternalUrl(url),
	fetch: (...args) => fetch(...args),
	timeoutMs: LOOPBACK_TIMEOUT_MS,
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A verified domain of the tenant (contoso.onmicrosoft.com, contoso.com).
const TENANT_DOMAIN =
	/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const TENANT_ALIASES = new Set(["common", "organizations", "consumers"]);

function base64Url(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

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

/** The `nonce` claim of an id_token, without verifying it (the server does). */
export function idTokenNonce(idToken: string): string | null {
	const payload = idToken.split(".")[1];
	if (!payload) return null;
	try {
		const claims = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf-8"),
		) as { nonce?: unknown };
		return typeof claims.nonce === "string" ? claims.nonce : null;
	} catch {
		return null;
	}
}

export function authorizeUrl(
	config: EntraConfig,
	params: {
		redirectUri: string;
		state: string;
		nonce: string;
		challenge: string;
	},
): string {
	const url = new URL(
		`${AUTHORITY}/${encodeURIComponent(config.entra_tenant_id)}/oauth2/v2.0/authorize`,
	);
	url.search = new URLSearchParams({
		client_id: config.entra_client_id,
		response_type: "code",
		redirect_uri: params.redirectUri,
		scope: ENTRA_SCOPES,
		state: params.state,
		nonce: params.nonce,
		code_challenge: params.challenge,
		code_challenge_method: "S256",
	}).toString();
	return url.toString();
}

/** Wait on a loopback port for the browser's redirect; resolve with the code. */
function waitForCode(
	state: string,
	open: (redirectUri: string) => Promise<void>,
	timeoutMs: number,
): Promise<{ code: string; redirectUri: string }> {
	return new Promise((resolve, reject) => {
		const server = http.createServer();
		let redirectUri = "";
		const finish = (error: Error | null, code?: string) => {
			clearTimeout(timeout);
			server.close();
			if (error) reject(error);
			else resolve({ code: code as string, redirectUri });
		};
		const timeout = setTimeout(
			() => finish(new Error("Login timed out (5 minutes)")),
			timeoutMs,
		);

		server.on("request", (req, res) => {
			const url = new URL(req.url as string, "http://localhost");
			if (req.method !== "GET" || url.pathname !== "/callback") {
				res.writeHead(404).end();
				return;
			}
			const error = url.searchParams.get("error_description");
			const returnedState = url.searchParams.get("state");
			const authCode = url.searchParams.get("code");
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(
				"<html><body style='font-family:sans-serif'><h3>WorkPilot AI</h3>" +
					"<p>Connexion terminée, vous pouvez fermer cet onglet.</p></body></html>",
			);
			if (returnedState !== state) finish(new Error("State mismatch"));
			else if (error) finish(new Error(error.slice(0, 300)));
			else if (!authCode) finish(new Error("No authorization code returned"));
			else finish(null, authCode);
		});

		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as { port: number };
			redirectUri = `http://localhost:${address.port}/callback`;
			open(redirectUri).catch((err: unknown) =>
				finish(err instanceof Error ? err : new Error(String(err))),
			);
		});
	});
}

/** Run the browser PKCE dance and resolve with the Entra id_token. */
export async function acquireEntraIdToken(
	rawConfig: EntraConfig,
	deps: Partial<EntraDeps> = {},
): Promise<string> {
	const { openBrowser, fetch: doFetch, timeoutMs } = { ...defaultDeps, ...deps };
	const config = checkEntraConfig(rawConfig);
	const verifier = base64Url(crypto.randomBytes(48));
	const challenge = base64Url(
		crypto.createHash("sha256").update(verifier).digest(),
	);
	const state = base64Url(crypto.randomBytes(16));
	const nonce = base64Url(crypto.randomBytes(16));

	const { code, redirectUri } = await waitForCode(
		state,
		(uri) =>
			openBrowser(
				authorizeUrl(config, { redirectUri: uri, state, nonce, challenge }),
			),
		timeoutMs,
	);

	const tokenRes = await doFetch(
		`${AUTHORITY}/${encodeURIComponent(config.entra_tenant_id)}/oauth2/v2.0/token`,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: config.entra_client_id,
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri,
				code_verifier: verifier,
				scope: ENTRA_SCOPES,
			}).toString(),
		},
	);
	const tokenJson = (await tokenRes.json()) as {
		id_token?: string;
		error_description?: string;
	};
	if (!tokenRes.ok || !tokenJson.id_token) {
		throw new Error(tokenJson.error_description || "Token exchange failed");
	}
	if (idTokenNonce(tokenJson.id_token) !== nonce) {
		throw new Error("The sign-in answer does not match this request");
	}
	return tokenJson.id_token;
}
