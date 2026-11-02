/**
 * Server Auth API — renderer bridge for multi-user server mode
 * (connection, login local / Microsoft Entra ID, session state).
 */

import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { IPCResult } from "../../../shared/types";
import type { ColorTheme } from "../../../shared/types/settings";

/** The person's integration tokens the server can hold (never read back). */
export type ServerSecretKind =
	| "github_token"
	| "gitlab_token"
	| "jira_token"
	| "linear_api_key"
	| "azure_pat";

export interface ServerUser {
	id: string;
	email: string;
	display_name: string;
	avatar_url?: string | null;
	role: string;
}

export interface ServerAuthState {
	mode: "local" | "server";
	serverUrl: string | null;
	user: ServerUser | null;
	isAuthenticated: boolean;
	// True once the user has made an explicit connection choice (server login
	// or local mode). Drives the first-launch login gate.
	configured: boolean;
}

export interface ServerAuthConfig {
	local_enabled: boolean;
	entra_enabled: boolean;
	entra_tenant_id: string | null;
	entra_client_id: string | null;
}

export type ServerAuthResult =
	| { ok: true; user: ServerUser }
	| { ok: false; error: string };

export interface InviteLookup {
	email: string;
	role: string;
}

export interface InvitationPublic {
	id: string;
	email: string;
	role: string;
	project_id?: string | null;
	project_role?: string | null;
	expires_at: string;
	created_at: string;
}

export interface CreateInvitationResult extends InvitationPublic {
	invite_link: string;
	email_sent: boolean;
}

export type DataResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ServerAuthAPI {
	getState: () => Promise<ServerAuthState>;
	getConfig: (
		serverUrl: string,
	) => Promise<{ ok: true; data: ServerAuthConfig } | { ok: false; error: string }>;
	setMode: (
		mode: "local" | "server",
		serverUrl?: string,
	) => Promise<ServerAuthState>;
	loginLocal: (
		serverUrl: string,
		email: string,
		password: string,
	) => Promise<ServerAuthResult>;
	loginEntra: (serverUrl: string) => Promise<ServerAuthResult>;
	lookupInvite: (
		serverUrl: string,
		token: string,
	) => Promise<DataResult<InviteLookup>>;
	acceptInvite: (
		serverUrl: string,
		token: string,
		displayName: string,
		password: string,
	) => Promise<ServerAuthResult>;
	createInvite: (payload: {
		email: string;
		role?: string;
		project_id?: string | null;
		project_role?: string | null;
	}) => Promise<DataResult<CreateInvitationResult>>;
	listInvites: () => Promise<DataResult<InvitationPublic[]>>;
	revokeInvite: (
		invitationId: string,
	) => Promise<DataResult<{ revoked: boolean }>>;
	listSecrets: () => Promise<IPCResult<ServerSecretKind[]>>;
	setSecret: (kind: ServerSecretKind, value: string) => Promise<IPCResult>;
	deleteSecret: (kind: ServerSecretKind) => Promise<IPCResult>;
	logout: () => Promise<ServerAuthState>;
	restore: () => Promise<ServerAuthState>;
	onStateChanged: (callback: (state: ServerAuthState) => void) => () => void;
	/** The person's theme from the server, already kept in the settings; null when none. */
	pullUiPreferences: () => Promise<ServerUiPreferences | null>;
}

export interface ServerUiPreferences {
	theme: "light" | "dark" | "system";
	colorTheme: ColorTheme;
}

export const createServerAuthAPI = (): ServerAuthAPI => ({
	getState: () => invokeIpc<ServerAuthState>(IPC_CHANNELS.SERVER_AUTH_GET_STATE),
	getConfig: (serverUrl) => invokeIpc(IPC_CHANNELS.SERVER_AUTH_GET_CONFIG, serverUrl),
	setMode: (mode, serverUrl) =>
		invokeIpc<ServerAuthState>(IPC_CHANNELS.SERVER_AUTH_SET_MODE, mode, serverUrl),
	loginLocal: (serverUrl, email, password) =>
		invokeIpc<ServerAuthResult>(
			IPC_CHANNELS.SERVER_AUTH_LOGIN_LOCAL,
			serverUrl,
			email,
			password,
		),
	loginEntra: (serverUrl) =>
		invokeIpc<ServerAuthResult>(IPC_CHANNELS.SERVER_AUTH_LOGIN_ENTRA, serverUrl),
	lookupInvite: (serverUrl, token) =>
		invokeIpc<DataResult<InviteLookup>>(
			IPC_CHANNELS.SERVER_AUTH_LOOKUP_INVITE,
			serverUrl,
			token,
		),
	acceptInvite: (serverUrl, token, displayName, password) =>
		invokeIpc<ServerAuthResult>(
			IPC_CHANNELS.SERVER_AUTH_ACCEPT_INVITE,
			serverUrl,
			token,
			displayName,
			password,
		),
	createInvite: (payload) =>
		invokeIpc<DataResult<CreateInvitationResult>>(
			IPC_CHANNELS.SERVER_AUTH_CREATE_INVITE,
			payload,
		),
	listInvites: () =>
		invokeIpc<DataResult<InvitationPublic[]>>(IPC_CHANNELS.SERVER_AUTH_LIST_INVITES),
	revokeInvite: (invitationId) =>
		invokeIpc<DataResult<{ revoked: boolean }>>(
			IPC_CHANNELS.SERVER_AUTH_REVOKE_INVITE,
			invitationId,
		),
	listSecrets: () =>
		invokeIpc<IPCResult<ServerSecretKind[]>>(IPC_CHANNELS.SERVER_AUTH_LIST_SECRETS),
	setSecret: (kind, value) =>
		invokeIpc<IPCResult>(IPC_CHANNELS.SERVER_AUTH_SET_SECRET, kind, value),
	deleteSecret: (kind) =>
		invokeIpc<IPCResult>(IPC_CHANNELS.SERVER_AUTH_DELETE_SECRET, kind),
	logout: () => invokeIpc<ServerAuthState>(IPC_CHANNELS.SERVER_AUTH_LOGOUT),
	restore: () => invokeIpc<ServerAuthState>(IPC_CHANNELS.SERVER_AUTH_RESTORE),
	pullUiPreferences: () =>
		invokeIpc<ServerUiPreferences | null>(IPC_CHANNELS.SERVER_AUTH_PULL_UI_PREFERENCES),
	onStateChanged: (callback) =>
		createIpcListener<[ServerAuthState]>(IPC_CHANNELS.SERVER_AUTH_STATE_CHANGED, (state) =>
			callback(state),
		),
});
