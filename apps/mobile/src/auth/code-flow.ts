/**
 * The browser sign-in both identity providers share (`entra.ts`, `sso.ts`):
 * Authorization Code + PKCE in the system browser, back to the app on
 * `workpilot://auth`, the code traded with the provider for an id_token. No
 * secret on the phone. `expo-auth-session` checks the `state` of the answer;
 * a `nonce` ties the id_token to this attempt, and one that does not carry it
 * is never sent to the server.
 */

import * as AuthSession from "expo-auth-session";
import * as Crypto from "expo-crypto";
import * as WebBrowser from "expo-web-browser";

// On the web build, the page the provider sends back to closes the popup.
WebBrowser.maybeCompleteAuthSession();

export function appRedirectUri(): string {
	return AuthSession.makeRedirectUri({ scheme: "workpilot", path: "auth" });
}

/** The `nonce` claim of an id_token, read without verifying it (the server does). */
export function nonceOf(idToken: string): unknown {
	const payload = idToken.split(".")[1];
	if (!payload) return undefined;
	try {
		const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const claims: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
		return claims && typeof claims === "object" ? (claims as { nonce?: unknown }).nonce : undefined;
	} catch {
		return undefined;
	}
}

export interface CodeFlow {
	discovery: AuthSession.DiscoveryDocument;
	clientId: string;
	scopes: string[];
	prompt?: AuthSession.Prompt;
	/** The error thrown when the provider answers without a usable id_token. */
	failure: string;
}

/** The id_token of the person's account, or null when they closed the page. */
export async function codeFlowIdToken(flow: CodeFlow): Promise<string | null> {
	const { discovery, clientId, failure } = flow;
	const redirectUri = appRedirectUri();
	const nonce = Crypto.randomUUID();
	const request = new AuthSession.AuthRequest({
		clientId,
		redirectUri,
		scopes: flow.scopes,
		responseType: AuthSession.ResponseType.Code,
		usePKCE: true,
		extraParams: { nonce },
		...(flow.prompt ? { prompt: flow.prompt } : {}),
	});
	const result = await request.promptAsync(discovery);
	if (result.type !== "success") {
		if (result.type === "error") throw new Error(result.error?.description || failure);
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
	if (!tokens.idToken || nonceOf(tokens.idToken) !== nonce) throw new Error(failure);
	return tokens.idToken;
}
