/**
 * IPC handlers for multi-user server mode: connection, password login,
 * session state.
 *
 * Sign-in with an identity provider of the server (Microsoft Entra ID or its
 * OpenID Connect provider) lives in ./server-sso-handlers.ts.
 */

import { type BrowserWindow, ipcMain } from "electron";
import {
	acceptInvite,
	createInvite,
	getAuthState,
	getServerAuthConfig,
	listInvites,
	loginLocal,
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
	confirmPasswordReset,
	issuePasswordReset,
	lookupPasswordReset,
	requestPasswordReset,
} from "../server-password-reset";
import { getServerSession } from "../server-session-info";
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

	// --- Forgotten password: every argument is checked in server-password-reset.ts ---

	ipcMain.handle(
		IPC_CHANNELS.SERVER_AUTH_REQUEST_PASSWORD_RESET,
		(_e, serverUrl: unknown, email: unknown) => requestPasswordReset(serverUrl, email),
	);
	ipcMain.handle(
		IPC_CHANNELS.SERVER_AUTH_LOOKUP_PASSWORD_RESET,
		(_e, serverUrl: unknown, link: unknown) => lookupPasswordReset(serverUrl, link),
	);
	ipcMain.handle(
		IPC_CHANNELS.SERVER_AUTH_CONFIRM_PASSWORD_RESET,
		(_e, serverUrl: unknown, link: unknown, password: unknown) =>
			confirmPasswordReset(serverUrl, link, password),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_AUTH_ISSUE_PASSWORD_RESET, (_e, userId: unknown) =>
		issuePasswordReset(userId),
	);

	ipcMain.handle(
		IPC_CHANNELS.SERVER_AUTH_CREATE_INVITE,
		async (
			_e,
			payload: {
				email: string;
				role?: string;
				org_role?: string | null;
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
	// No argument from the renderer: the current session, as the server reports it.
	ipcMain.handle(IPC_CHANNELS.SERVER_AUTH_GET_SESSION, () => getServerSession());

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
