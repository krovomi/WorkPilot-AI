/**
 * Server Auth API — renderer bridge for multi-user server mode
 * (connection, login local / Microsoft Entra ID, session state).
 */

import { createIpcListener, invokeIpc } from "./ipc-utils";

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
	logout: () => Promise<ServerAuthState>;
	restore: () => Promise<ServerAuthState>;
	onStateChanged: (callback: (state: ServerAuthState) => void) => () => void;
}

export const createServerAuthAPI = (): ServerAuthAPI => ({
	getState: () => invokeIpc<ServerAuthState>("server-auth:get-state"),
	getConfig: (serverUrl) => invokeIpc("server-auth:get-config", serverUrl),
	setMode: (mode, serverUrl) =>
		invokeIpc<ServerAuthState>("server-auth:set-mode", mode, serverUrl),
	loginLocal: (serverUrl, email, password) =>
		invokeIpc<ServerAuthResult>(
			"server-auth:login-local",
			serverUrl,
			email,
			password,
		),
	loginEntra: (serverUrl) =>
		invokeIpc<ServerAuthResult>("server-auth:login-entra", serverUrl),
	logout: () => invokeIpc<ServerAuthState>("server-auth:logout"),
	restore: () => invokeIpc<ServerAuthState>("server-auth:restore"),
	onStateChanged: (callback) =>
		createIpcListener<[ServerAuthState]>("server-auth:state-changed", (state) =>
			callback(state),
		),
});
