/**
 * Sign-in with the WorkPilot server's OpenID Connect provider (Okta, Google,
 * Keycloak, Auth0...): the server names the provider in `/auth/config`, the
 * browser flow runs in `oidc-pkce.ts`, the id_token goes to `/auth/sso/exchange`.
 *
 * The server URL comes from the renderer and is checked here before use.
 */

import { type BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { acquireIdToken, providerFromConfig, type PkceDeps } from "../oidc-pkce";
import {
	getAuthState,
	getServerAuthConfig,
	loginWithSsoIdToken,
	setMode,
} from "../server-connection";

type LoginResult =
	| Awaited<ReturnType<typeof loginWithSsoIdToken>>
	| { ok: false; error: string };

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

/** The whole sign-in, from the server URL to the session. */
export async function loginSso(
	rawServerUrl: unknown,
	deps: Partial<PkceDeps> = {},
): Promise<LoginResult> {
	const serverUrl = serverUrlFrom(rawServerUrl);
	if (!serverUrl) return { ok: false, error: "Invalid server URL" };
	const config = await getServerAuthConfig(serverUrl);
	if (!config.ok) return config;
	const provider = providerFromConfig(config.data);
	if (!provider) {
		return {
			ok: false,
			error: "Single sign-on is not configured on this server",
		};
	}
	setMode("server", serverUrl);
	try {
		const idToken = await acquireIdToken(provider, deps);
		return await loginWithSsoIdToken(idToken);
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function registerServerSsoHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	ipcMain.handle(
		IPC_CHANNELS.SERVER_AUTH_LOGIN_SSO,
		async (_e, serverUrl: unknown) => {
			const result = await loginSso(serverUrl);
			getMainWindow()?.webContents.send(
				IPC_CHANNELS.SERVER_AUTH_STATE_CHANGED,
				getAuthState(),
			);
			return result;
		},
	);
}
