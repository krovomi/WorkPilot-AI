/**
 * IPC handlers for multi-user server mode: connection, login (local +
 * Microsoft Entra ID PKCE), session state.
 *
 * The Entra flow lives in ../entra-sign-in.ts.
 */

import { type BrowserWindow, ipcMain } from "electron";
import { acquireEntraIdToken } from "../entra-sign-in";
import {
	acceptInvite,
	createInvite,
	getAuthState,
	getServerAuthConfig,
	listInvites,
	loginLocal,
	loginWithEntraIdToken,
	logout,
	lookupInvite,
	restoreSession,
	revokeInvite,
	setMode,
} from "../server-connection";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { unwatchAllServerBoards } from "../server-board-live";
import { leaveAllTeamRooms } from "../server-team-room";
import { unwatchAllServerCardLogs } from "../server-card-logs";
import { unwatchAllServerViews } from "../server-live-views";
import {
	createAccessToken,
	listAccessTokens,
	revokeAccessToken,
} from "../server-access-tokens";
import {
	deleteServerSecret,
	listServerSecrets,
	setServerSecret,
} from "../server-user-secrets";
import { pullServerInterface } from "../server-menu-layout";
import {
	deleteServerNeedsYouChannel,
	getServerNeedsYou,
	saveServerNeedsYouChannel,
	saveServerNeedsYouPreferences,
	testServerNeedsYouChannel,
} from "../server-needs-you";

export function registerServerAuthHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	const notifyRenderer = () => {
		getMainWindow()?.webContents.send(
			IPC_CHANNELS.SERVER_AUTH_STATE_CHANGED,
			getAuthState(),
		);
	};

	ipcMain.handle(IPC_CHANNELS.SERVER_AUTH_GET_STATE, () => getAuthState());

	ipcMain.handle(
		IPC_CHANNELS.SERVER_AUTH_GET_CONFIG,
		async (_e, serverUrl: string) => await getServerAuthConfig(serverUrl),
	);

	ipcMain.handle(
		IPC_CHANNELS.SERVER_AUTH_SET_MODE,
		(_e, mode: "local" | "server", serverUrl?: string) => {
			setMode(mode, serverUrl);
			notifyRenderer();
			return getAuthState();
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.SERVER_AUTH_LOGIN_LOCAL,
		async (_e, serverUrl: string, email: string, password: string) => {
			setMode("server", serverUrl);
			const result = await loginLocal(email, password);
			notifyRenderer();
			return result;
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.SERVER_AUTH_LOGIN_ENTRA,
		async (_e, serverUrl: string) => {
			setMode("server", serverUrl);
			const config = await getServerAuthConfig(serverUrl);
			if (!config.ok) return config;
			if (!config.data.entra_enabled || !config.data.entra_tenant_id) {
				return {
					ok: false as const,
					error: "Entra ID n'est pas configuré sur ce serveur",
				};
			}
			try {
				const idToken = await acquireEntraIdToken({
					entra_tenant_id: config.data.entra_tenant_id,
					entra_client_id: config.data.entra_client_id as string,
				});
				const result = await loginWithEntraIdToken(idToken);
				notifyRenderer();
				return result;
			} catch (err) {
				return {
					ok: false as const,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		},
	);

	// --- Invitation-only self-service signup ---

	ipcMain.handle(
		IPC_CHANNELS.SERVER_AUTH_LOOKUP_INVITE,
		async (_e, serverUrl: string, token: string) =>
			await lookupInvite(serverUrl, token),
	);

	ipcMain.handle(
		IPC_CHANNELS.SERVER_AUTH_ACCEPT_INVITE,
		async (
			_e,
			serverUrl: string,
			token: string,
			displayName: string,
			password: string,
		) => {
			setMode("server", serverUrl);
			const result = await acceptInvite(token, displayName, password);
			notifyRenderer();
			return result;
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.SERVER_AUTH_CREATE_INVITE,
		async (
			_e,
			payload: {
				email: string;
				role?: string;
				project_id?: string | null;
				project_role?: string | null;
			},
		) => await createInvite(payload),
	);

	ipcMain.handle(
		IPC_CHANNELS.SERVER_AUTH_LIST_INVITES,
		async () => await listInvites(),
	);

	ipcMain.handle(
		IPC_CHANNELS.SERVER_AUTH_REVOKE_INVITE,
		async (_e, invitationId: string) => await revokeInvite(invitationId),
	);

	ipcMain.handle(IPC_CHANNELS.SERVER_AUTH_LIST_ACCESS_TOKENS, () => listAccessTokens());
	ipcMain.handle(
		IPC_CHANNELS.SERVER_AUTH_CREATE_ACCESS_TOKEN,
		(_e, name: unknown, scope: unknown, ttlDays: unknown) =>
			createAccessToken(name, scope, ttlDays),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_AUTH_REVOKE_ACCESS_TOKEN, (_e, id: unknown) =>
		revokeAccessToken(id),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_AUTH_LIST_SECRETS, () => listServerSecrets());
	ipcMain.handle(IPC_CHANNELS.SERVER_AUTH_SET_SECRET, (_e, kind: unknown, value: unknown) =>
		setServerSecret(kind, value),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_AUTH_DELETE_SECRET, (_e, kind: unknown) =>
		deleteServerSecret(kind),
	);
	// No argument from the renderer: main reads the server and the settings file.
	ipcMain.handle(IPC_CHANNELS.SERVER_AUTH_PULL_UI_PREFERENCES, () => pullServerInterface());

	ipcMain.handle(IPC_CHANNELS.SERVER_NEEDS_YOU_GET, () => getServerNeedsYou());
	ipcMain.handle(
		IPC_CHANNELS.SERVER_NEEDS_YOU_SAVE_CHANNEL,
		(_e, channel: unknown, input: unknown) => saveServerNeedsYouChannel(channel, input),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_NEEDS_YOU_DELETE_CHANNEL, (_e, channel: unknown) =>
		deleteServerNeedsYouChannel(channel),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_NEEDS_YOU_TEST_CHANNEL, (_e, channel: unknown) =>
		testServerNeedsYouChannel(channel),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_NEEDS_YOU_SAVE_PREFERENCES, (_e, prefs: unknown) =>
		saveServerNeedsYouPreferences(prefs),
	);

	ipcMain.handle(IPC_CHANNELS.SERVER_AUTH_LOGOUT, async () => {
		unwatchAllServerBoards();
		leaveAllTeamRooms();
		unwatchAllServerViews();
		unwatchAllServerCardLogs();
		await logout();
		notifyRenderer();
		return getAuthState();
	});

	ipcMain.handle(IPC_CHANNELS.SERVER_AUTH_RESTORE, async () => {
		await restoreSession();
		notifyRenderer();
		return getAuthState();
	});
}
