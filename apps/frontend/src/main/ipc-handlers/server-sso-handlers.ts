/**
 * Sign-in with an identity provider of the WorkPilot server: its OpenID
 * Connect provider (Okta, Google, Keycloak, Auth0...) or Microsoft Entra ID.
 * Both are one browser flow (`oidc-pkce.ts`), set up from what the server
 * describes in `/auth/config`; only where the id_token goes differs, because
 * the server checks an Entra id_token as Entra's (`/auth/oidc/exchange`) and
 * any other as its provider's (`/auth/sso/exchange`).
 *
 * The server URL comes from the renderer and is checked here before use; the
 * kind of sign-in is chosen by the channel, never by the renderer's data.
 */

import { type BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { entraProviderFromConfig } from "../entra-sign-in";
import {
	acquireIdToken,
	type OidcProvider,
	type PkceDeps,
	providerFromConfig,
} from "../oidc-pkce";
import {
	getAuthState,
	getServerAuthConfig,
	loginWithEntraIdToken,
	loginWithSsoIdToken,
	setMode,
} from "../server-connection";

type LoginResult =
	| Awaited<ReturnType<typeof loginWithSsoIdToken>>
	| { ok: false; error: string };

export type SignInKind = "oidc" | "entra";

interface SignIn {
	/** The provider the server describes; null when it offers none. */
	provider: (config: unknown) => OidcProvider | null;
	/** Hand the id_token to the server, which answers with its own session. */
	exchange: (idToken: string) => Promise<LoginResult>;
	notConfigured: string;
}

const SIGN_INS: Record<SignInKind, SignIn> = {
	oidc: {
		provider: providerFromConfig,
		exchange: loginWithSsoIdToken,
		notConfigured: "Single sign-on is not configured on this server",
	},
	entra: {
		provider: entraProviderFromConfig,
		exchange: loginWithEntraIdToken,
		notConfigured: "Microsoft Entra ID is not configured on this server",
	},
};

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `raw` when it is an http(s) URL without credentials, else null. */
export function serverUrlFrom(raw: unknown): string | null {
	if (typeof raw !== "string" || !raw.trim() || raw.length > 2000) return null;
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (url.username || url.password) return null;
	return raw.trim().replace(/\/+$/, "");
}

/** The whole sign-in with one of the server's providers, from its URL to the session. */
export async function loginWithProvider(
	kind: SignInKind,
	rawServerUrl: unknown,
	deps: Partial<PkceDeps> = {},
): Promise<LoginResult> {
	const signIn = SIGN_INS[kind];
	const serverUrl = serverUrlFrom(rawServerUrl);
	if (!serverUrl) return { ok: false, error: "Invalid server URL" };
	const config = await getServerAuthConfig(serverUrl);
	if (!config.ok) return config;
	let provider: OidcProvider | null;
	try {
		provider = signIn.provider(config.data);
	} catch (error) {
		return { ok: false, error: message(error) };
	}
	if (!provider) return { ok: false, error: signIn.notConfigured };
	setMode("server", serverUrl);
	try {
		const idToken = await acquireIdToken(provider, deps);
		return await signIn.exchange(idToken);
	} catch (error) {
		return { ok: false, error: message(error) };
	}
}

/** The server's OpenID Connect provider. */
export function loginSso(
	rawServerUrl: unknown,
	deps: Partial<PkceDeps> = {},
): Promise<LoginResult> {
	return loginWithProvider("oidc", rawServerUrl, deps);
}

export function registerServerSsoHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	const signIn = async (kind: SignInKind, serverUrl: unknown) => {
		const result = await loginWithProvider(kind, serverUrl);
		getMainWindow()?.webContents.send(
			IPC_CHANNELS.SERVER_AUTH_STATE_CHANGED,
			getAuthState(),
		);
		return result;
	};
	ipcMain.handle(IPC_CHANNELS.SERVER_AUTH_LOGIN_SSO, (_e, serverUrl: unknown) =>
		signIn("oidc", serverUrl),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_AUTH_LOGIN_ENTRA, (_e, serverUrl: unknown) =>
		signIn("entra", serverUrl),
	);
}
