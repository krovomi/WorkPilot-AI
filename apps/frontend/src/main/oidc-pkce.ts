/**
 * Sign-in with any OpenID Connect provider, as a public client: Authorization
 * Code + PKCE in the system browser, a loopback redirect, the token exchange
 * from the main process (RFC 8252). The WorkPilot server says which provider
 * (`/auth/config`, from the provider's discovery document) and checks the
 * id_token this returns (`apps/backend/server/auth/oidc_generic.py`).
 *
 * What comes from the server is checked here again before it is used: every
 * endpoint is an https URL (http only on loopback), the client id and the
 * scopes are bounded tokens. A `state` and a `nonce` tie the answer to this
 * attempt; the id_token is checked for that nonce before it leaves the main.
 */

import * as crypto from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { openExternalUrl } from "./open-external";

export const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CLIENT_ID = /^[\x21-\x7E]{1,200}$/;
const SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]{1,100}$/;

export interface OidcProvider {
	authorizationEndpoint: string;
	tokenEndpoint: string;
	clientId: string;
	scopes: string;
}

export interface PkceDeps {
	openBrowser: (url: string) => Promise<void>;
	fetchToken: typeof fetch;
	timeoutMs: number;
}

const defaultDeps: PkceDeps = {
	openBrowser: (url) => openExternalUrl(url),
	fetchToken: (input, init) => fetch(input, init),
	timeoutMs: LOOPBACK_TIMEOUT_MS,
};

/** `raw` when it is an https URL (http on loopback), with no credentials. */
export function endpointUrl(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.length > 2000) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	const secure =
		url.protocol === "https:" ||
		(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
	if (!secure || url.username || url.password || url.hash) return null;
	return url.toString();
}

/** The provider the server describes, or null when any part is unusable. */
export function providerFromConfig(config: unknown): OidcProvider | null {
	if (!config || typeof config !== "object") return null;
	const data = config as Record<string, unknown>;
	if (data.sso_enabled !== true) return null;
	const authorizationEndpoint = endpointUrl(data.sso_authorization_endpoint);
	const tokenEndpoint = endpointUrl(data.sso_token_endpoint);
	const clientId = data.sso_client_id;
	const scopes =
		typeof data.sso_scopes === "string" ? data.sso_scopes.split(" ") : [];
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
	return {
		authorizationEndpoint,
		tokenEndpoint,
		clientId,
		scopes: scopes.join(" "),
	};
}

function base64Url(buffer: Buffer): string {
	return buffer.toString("base64url");
}

/** The `nonce` claim of an id_token, read without verifying it (the server does). */
export function nonceOf(idToken: string): unknown {
	const payload = idToken.split(".")[1];
	if (!payload) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		return claims && typeof claims === "object" ? claims.nonce : undefined;
	} catch {
		return undefined;
	}
}

const DONE_PAGE =
	"<!doctype html><meta charset='utf-8'><title>WorkPilot AI</title>" +
	"<body style='font-family:sans-serif'><h3>WorkPilot AI</h3>" +
	"<p>Sign-in complete: you can close this tab.</p>" +
	"<p lang='fr'>Connexion terminée : vous pouvez fermer cet onglet.</p></body>";

/** Wait on a loopback port for the provider's redirect; resolve with the code. */
function awaitCode(
	provider: OidcProvider,
	state: string,
	nonce: string,
	challenge: string,
	deps: PkceDeps,
): Promise<{ code: string; redirectUri: string }> {
	return new Promise((resolve, reject) => {
		const server = http.createServer();
		let redirectUri = "";
		const finish = (error: Error | null, code?: string) => {
			clearTimeout(timer);
			server.close();
			if (error) reject(error);
			else resolve({ code: code as string, redirectUri });
		};
		const timer = setTimeout(
			() => finish(new Error("Sign-in timed out")),
			deps.timeoutMs,
		);

		server.on("request", (req, res) => {
			// A request on an http.Server always has its path.
			const url = new URL(String(req.url), "http://localhost");
			if (url.pathname !== "/callback") {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(DONE_PAGE);
			const code = url.searchParams.get("code");
			const refusal = url.searchParams.get("error");
			if (url.searchParams.get("state") !== state) {
				finish(new Error("The sign-in answer does not match this attempt"));
			} else if (refusal) {
				// The provider's own words stay out: only its error code, bounded.
				finish(
					new Error(`The identity provider refused: ${refusal.slice(0, 60)}`),
				);
			} else if (!code) {
				finish(new Error("The identity provider returned no code"));
			} else {
				finish(null, code);
			}
		});

		server.listen(0, "127.0.0.1", () => {
			// Listening on a TCP host, the address is never a pipe name.
			const { port } = server.address() as AddressInfo;
			redirectUri = `http://localhost:${port}/callback`;
			const authorize = new URL(provider.authorizationEndpoint);
			const query = {
				client_id: provider.clientId,
				response_type: "code",
				redirect_uri: redirectUri,
				scope: provider.scopes,
				state,
				nonce,
				code_challenge: challenge,
				code_challenge_method: "S256",
			};
			for (const [key, value] of Object.entries(query)) {
				authorize.searchParams.set(key, value);
			}
			deps
				.openBrowser(authorize.toString())
				.catch((error: unknown) =>
					finish(error instanceof Error ? error : new Error(String(error))),
				);
		});
	});
}

/** Run the browser sign-in and resolve with the provider's id_token. */
export async function acquireIdToken(
	provider: OidcProvider,
	deps: Partial<PkceDeps> = {},
): Promise<string> {
	const resolved = { ...defaultDeps, ...deps };
	const verifier = base64Url(crypto.randomBytes(48));
	const challenge = base64Url(
		crypto.createHash("sha256").update(verifier).digest(),
	);
	const state = base64Url(crypto.randomBytes(16));
	const nonce = base64Url(crypto.randomBytes(16));

	const { code, redirectUri } = await awaitCode(
		provider,
		state,
		nonce,
		challenge,
		resolved,
	);
	const response = await resolved.fetchToken(provider.tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: provider.clientId,
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		}).toString(),
	});
	let body: { id_token?: unknown } = {};
	try {
		body = (await response.json()) as { id_token?: unknown };
	} catch {
		body = {};
	}
	if (!response.ok || typeof body.id_token !== "string") {
		throw new Error(`The token exchange failed (HTTP ${response.status})`);
	}
	if (nonceOf(body.id_token) !== nonce) {
		throw new Error("The id_token was not issued for this sign-in");
	}
	return body.id_token;
}
