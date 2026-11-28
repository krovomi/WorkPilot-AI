/**
 * Server Auth API — renderer bridge for multi-user server mode
 * (connection, login local / Microsoft Entra ID, session state).
 */

import { createIpcListener, invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	IPCResult,
	ServerAccessToken,
	ServerAccessTokenCreated,
} from "../../../shared/types";
import type { ServerSessionInfo } from "../../../shared/types/server-session";
import type { ColorTheme, SidebarPrefs } from "../../../shared/types/settings";
import type {
	NeedsYouChannelKind,
	NeedsYouEventKind,
	ServerNeedsYouChannelInput,
	ServerNeedsYouOverview,
	ServerNeedsYouTestResult,
} from "../../../shared/types/server-needs-you";

/** The person's integration tokens the server can hold (never read back). */
export type ServerSecretKind =
	| "github_token"
	| "gitlab_token"
	| "jira_token"
	| "linear_api_key"
	| "azure_pat"
	| "sentry_token";

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
	/** Sign-in with the server's OpenID Connect provider (Okta, Google, Keycloak...). */
	sso_enabled?: boolean;
	/** The provider's name, for the button. */
	sso_name?: string;
	/** "Forgot password?" emails a link; otherwise an administrator issues it. */
	password_reset_by_email?: boolean;
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

/** A link a platform admin issued for an account to set a new password. */
export interface PasswordResetIssued {
	email: string;
	expires_at: string;
	email_sent: boolean;
	/** Only when no email went: the admin hands the link over. */
	reset_link: string | null;
}

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
	loginSso: (serverUrl: string) => Promise<ServerAuthResult>;
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
	requestPasswordReset: (
		serverUrl: string,
		email: string,
	) => Promise<DataResult<{ requested: boolean }>>;
	lookupPasswordReset: (
		serverUrl: string,
		link: string,
	) => Promise<DataResult<{ email: string }>>;
	confirmPasswordReset: (
		serverUrl: string,
		link: string,
		password: string,
	) => Promise<DataResult<{ reset: boolean }>>;
	issuePasswordReset: (userId: string) => Promise<DataResult<PasswordResetIssued>>;
	createInvite: (payload: {
		email: string;
		role?: string;
		org_role?: string | null;
		project_id?: string | null;
		project_role?: string | null;
	}) => Promise<DataResult<CreateInvitationResult>>;
	listInvites: () => Promise<DataResult<InvitationPublic[]>>;
	revokeInvite: (
		invitationId: string,
	) => Promise<DataResult<{ revoked: boolean }>>;
	listAccessTokens: () => Promise<IPCResult<ServerAccessToken[]>>;
	createAccessToken: (
		name: string,
		scope: "read" | "write",
		ttlDays: number,
	) => Promise<IPCResult<ServerAccessTokenCreated>>;
	revokeAccessToken: (id: string) => Promise<IPCResult>;
	listSecrets: () => Promise<IPCResult<ServerSecretKind[]>>;
	setSecret: (kind: ServerSecretKind, value: string) => Promise<IPCResult>;
	deleteSecret: (kind: ServerSecretKind) => Promise<IPCResult>;
	getNeedsYou: () => Promise<IPCResult<ServerNeedsYouOverview>>;
	saveNeedsYouChannel: (
		channel: NeedsYouChannelKind,
		input: ServerNeedsYouChannelInput,
	) => Promise<IPCResult>;
	deleteNeedsYouChannel: (channel: NeedsYouChannelKind) => Promise<IPCResult>;
	testNeedsYouChannel: (
		channel: NeedsYouChannelKind,
	) => Promise<IPCResult<ServerNeedsYouTestResult>>;
	saveNeedsYouPreferences: (prefs: {
		events: Record<NeedsYouEventKind, boolean>;
		locale: "en" | "fr";
	}) => Promise<IPCResult>;
	logout: () => Promise<ServerAuthState>;
	restore: () => Promise<ServerAuthState>;
	onStateChanged: (callback: (state: ServerAuthState) => void) => () => void;
	/**
	 * The person's theme and menu layout from the server, already kept in the
	 * settings; null when the server has neither.
	 */
	pullUiPreferences: () => Promise<ServerUiPreferences | null>;
	/** How the current session was opened and who it is, as the server reports it. */
	getSession: () => Promise<IPCResult<ServerSessionInfo>>;
}

export interface ServerUiPreferences {
	theme?: "light" | "dark" | "system";
	colorTheme?: ColorTheme;
	/** The sidebar preferences with the layout the person saved on the server. */
	sidebarPrefs?: SidebarPrefs;
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
	loginSso: (serverUrl) =>
		invokeIpc<ServerAuthResult>(IPC_CHANNELS.SERVER_AUTH_LOGIN_SSO, serverUrl),
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
	requestPasswordReset: (serverUrl, email) =>
		invokeIpc<DataResult<{ requested: boolean }>>(
			IPC_CHANNELS.SERVER_AUTH_REQUEST_PASSWORD_RESET,
			serverUrl,
			email,
		),
	lookupPasswordReset: (serverUrl, link) =>
		invokeIpc<DataResult<{ email: string }>>(
			IPC_CHANNELS.SERVER_AUTH_LOOKUP_PASSWORD_RESET,
			serverUrl,
			link,
		),
	confirmPasswordReset: (serverUrl, link, password) =>
		invokeIpc<DataResult<{ reset: boolean }>>(
			IPC_CHANNELS.SERVER_AUTH_CONFIRM_PASSWORD_RESET,
			serverUrl,
			link,
			password,
		),
	issuePasswordReset: (userId) =>
		invokeIpc<DataResult<PasswordResetIssued>>(
			IPC_CHANNELS.SERVER_AUTH_ISSUE_PASSWORD_RESET,
			userId,
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
	listAccessTokens: () =>
		invokeIpc<IPCResult<ServerAccessToken[]>>(IPC_CHANNELS.SERVER_AUTH_LIST_ACCESS_TOKENS),
	createAccessToken: (name, scope, ttlDays) =>
		invokeIpc<IPCResult<ServerAccessTokenCreated>>(
			IPC_CHANNELS.SERVER_AUTH_CREATE_ACCESS_TOKEN,
			name,
			scope,
			ttlDays,
		),
	revokeAccessToken: (id) =>
		invokeIpc<IPCResult>(IPC_CHANNELS.SERVER_AUTH_REVOKE_ACCESS_TOKEN, id),
	listSecrets: () =>
		invokeIpc<IPCResult<ServerSecretKind[]>>(IPC_CHANNELS.SERVER_AUTH_LIST_SECRETS),
	setSecret: (kind, value) =>
		invokeIpc<IPCResult>(IPC_CHANNELS.SERVER_AUTH_SET_SECRET, kind, value),
	deleteSecret: (kind) =>
		invokeIpc<IPCResult>(IPC_CHANNELS.SERVER_AUTH_DELETE_SECRET, kind),
	getNeedsYou: () =>
		invokeIpc<IPCResult<ServerNeedsYouOverview>>(IPC_CHANNELS.SERVER_NEEDS_YOU_GET),
	saveNeedsYouChannel: (channel, input) =>
		invokeIpc<IPCResult>(IPC_CHANNELS.SERVER_NEEDS_YOU_SAVE_CHANNEL, channel, input),
	deleteNeedsYouChannel: (channel) =>
		invokeIpc<IPCResult>(IPC_CHANNELS.SERVER_NEEDS_YOU_DELETE_CHANNEL, channel),
	testNeedsYouChannel: (channel) =>
		invokeIpc<IPCResult<ServerNeedsYouTestResult>>(
			IPC_CHANNELS.SERVER_NEEDS_YOU_TEST_CHANNEL,
			channel,
		),
	saveNeedsYouPreferences: (prefs) =>
		invokeIpc<IPCResult>(IPC_CHANNELS.SERVER_NEEDS_YOU_SAVE_PREFERENCES, prefs),
	logout: () => invokeIpc<ServerAuthState>(IPC_CHANNELS.SERVER_AUTH_LOGOUT),
	restore: () => invokeIpc<ServerAuthState>(IPC_CHANNELS.SERVER_AUTH_RESTORE),
	pullUiPreferences: () =>
		invokeIpc<ServerUiPreferences | null>(IPC_CHANNELS.SERVER_AUTH_PULL_UI_PREFERENCES),
	getSession: () =>
		invokeIpc<IPCResult<ServerSessionInfo>>(IPC_CHANNELS.SERVER_AUTH_GET_SESSION),
	onStateChanged: (callback) =>
		createIpcListener<[ServerAuthState]>(IPC_CHANNELS.SERVER_AUTH_STATE_CHANGED, (state) =>
			callback(state),
		),
});
