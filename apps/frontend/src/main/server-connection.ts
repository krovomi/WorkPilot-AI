/**
 * Server-mode connection manager (multi-user deployments).
 *
 * Holds the connection state for "server mode": which remote WorkPilot
 * server we talk to, the current user, and the JWT pair. The access token
 * lives only in main-process memory; the refresh token is persisted with
 * Electron safeStorage (OS-level encryption) so a restart keeps the session.
 *
 * In "local mode" (default) this module is dormant and every consumer
 * falls back to the historical localhost behavior.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { app, safeStorage } from "electron";

export type ConnectionMode = "local" | "server";

export interface ServerUser {
	id: string;
	email: string;
	display_name: string;
	avatar_url?: string | null;
	role: string;
}

export interface ServerAuthState {
	mode: ConnectionMode;
	serverUrl: string | null;
	user: ServerUser | null;
	isAuthenticated: boolean;
	// True once the user has made an explicit connection choice (signed in to
	// a server, or picked local mode). Drives the first-launch login gate.
	configured: boolean;
}

interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	user: ServerUser;
}

interface PersistedState {
	mode: ConnectionMode;
	serverUrl: string | null;
	encryptedRefreshToken: string | null; // base64 of safeStorage buffer
}

let mode: ConnectionMode = "local";
let serverUrl: string | null = null;
let accessToken: string | null = null;
let refreshToken: string | null = null;
let currentUser: ServerUser | null = null;
// The organization every authed request acts in, sent as X-WorkPilot-Org.
let activeOrgId: string | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
// Whether a connection choice has ever been persisted (first-launch gate).
let configured = false;
// Shared in-flight restore so a concurrent main+renderer restore does not
// refresh twice (refresh rotates the token — a double call would fail).
let restoreInFlight: Promise<boolean> | null = null;

function stateFilePath(): string {
	return path.join(app.getPath("userData"), "server-connection.json");
}

function persist(): void {
	try {
		let encryptedRefreshToken: string | null = null;
		if (refreshToken && safeStorage.isEncryptionAvailable()) {
			encryptedRefreshToken = safeStorage
				.encryptString(refreshToken)
				.toString("base64");
		}
		const state: PersistedState = { mode, serverUrl, encryptedRefreshToken };
		fs.writeFileSync(stateFilePath(), JSON.stringify(state), "utf-8");
		configured = true;
	} catch (err) {
		console.error("[server-connection] Failed to persist state:", err);
	}
}

export function loadPersistedState(): void {
	try {
		if (!fs.existsSync(stateFilePath())) return;
		const raw = JSON.parse(
			fs.readFileSync(stateFilePath(), "utf-8"),
		) as PersistedState;
		// A persisted file means the user has already made a connection choice.
		configured = true;
		mode = raw.mode === "server" ? "server" : "local";
		serverUrl = raw.serverUrl || null;
		if (raw.encryptedRefreshToken && safeStorage.isEncryptionAvailable()) {
			refreshToken = safeStorage.decryptString(
				Buffer.from(raw.encryptedRefreshToken, "base64"),
			);
		}
	} catch (err) {
		console.error("[server-connection] Failed to load persisted state:", err);
	}
}

export function isServerMode(): boolean {
	return mode === "server" && !!serverUrl;
}

export function getServerUrl(): string | null {
	return serverUrl;
}

export function getAccessToken(): string | null {
	return accessToken;
}

export function getAuthState(): ServerAuthState {
	return {
		mode,
		serverUrl,
		user: currentUser,
		isAuthenticated: !!accessToken,
		configured,
	};
}

export function setMode(newMode: ConnectionMode, url?: string): void {
	mode = newMode;
	if (newMode === "server" && url) {
		serverUrl = url.replace(/\/+$/, "");
	}
	if (newMode === "local") {
		clearSession();
	}
	persist();
}

function applyTokens(tokens: TokenResponse): void {
	accessToken = tokens.access_token;
	refreshToken = tokens.refresh_token;
	currentUser = tokens.user;
	persist();
	scheduleRefresh(tokens.expires_in);
}

function scheduleRefresh(expiresInSeconds: number): void {
	if (refreshTimer) clearTimeout(refreshTimer);
	// Refresh 60s before expiry (minimum 30s from now).
	const delayMs = Math.max((expiresInSeconds - 60) * 1000, 30_000);
	refreshTimer = setTimeout(() => {
		refreshSession().catch((err) =>
			console.error("[server-connection] Scheduled refresh failed:", err),
		);
	}, delayMs);
	refreshTimer.unref?.();
}

function clearSession(): void {
	accessToken = null;
	refreshToken = null;
	currentUser = null;
	// Signing out must not leave the next session pointed at the previous
	// user's tenant.
	activeOrgId = null;
	if (refreshTimer) {
		clearTimeout(refreshTimer);
		refreshTimer = null;
	}
}

async function serverFetch<T>(
	pathName: string,
	body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
	if (!serverUrl) return { ok: false, error: "No server URL configured" };
	try {
		const res = await fetch(`${serverUrl}${pathName}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const text = await res.text();
		if (!res.ok) {
			try {
				const parsed = JSON.parse(text) as { detail?: string };
				return { ok: false, error: parsed.detail || `HTTP ${res.status}` };
			} catch {
				return { ok: false, error: text || `HTTP ${res.status}` };
			}
		}
		return { ok: true, data: JSON.parse(text) as T };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function getServerAuthConfig(
	url: string,
): Promise<
	| { ok: true; data: { local_enabled: boolean; entra_enabled: boolean; entra_tenant_id: string | null; entra_client_id: string | null } }
	| { ok: false; error: string }
> {
	try {
		const res = await fetch(`${url.replace(/\/+$/, "")}/auth/config`);
		if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
		return { ok: true, data: await res.json() };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Authenticated request against the current server, attaching the access
 * token. Used by admin-only invitation management.
 */
async function authedFetch<T>(
	pathName: string,
	method: string,
	body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
	if (!serverUrl) return { ok: false, error: "No server URL configured" };
	if (!accessToken) return { ok: false, error: "Not authenticated" };
	try {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		};
		// Which tenant this request acts in. The server verifies membership
		// against the database every time, so this only *selects* among the
		// organizations the caller already belongs to — it never grants access.
		if (activeOrgId) headers["X-WorkPilot-Org"] = activeOrgId;

		const res = await fetch(`${serverUrl}${pathName}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		if (!res.ok) {
			try {
				const parsed = JSON.parse(text) as { detail?: string };
				return { ok: false, error: parsed.detail || `HTTP ${res.status}` };
			} catch {
				return { ok: false, error: text || `HTTP ${res.status}` };
			}
		}
		return { ok: true, data: (text ? JSON.parse(text) : null) as T };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

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

/**
 * Public invite lookup (no auth, no global state mutation): used by the
 * accept-invitation screen to prefill the bound email. POST (not GET) so the
 * token is never placed in a URL / proxy access log.
 */
export async function lookupInvite(
	url: string,
	token: string,
): Promise<{ ok: true; data: InviteLookup } | { ok: false; error: string }> {
	try {
		const res = await fetch(
			`${url.replace(/\/+$/, "")}/auth/invitations/lookup`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token }),
			},
		);
		const text = await res.text();
		if (!res.ok) {
			try {
				const parsed = JSON.parse(text) as { detail?: string };
				return { ok: false, error: parsed.detail || `HTTP ${res.status}` };
			} catch {
				return { ok: false, error: `HTTP ${res.status}` };
			}
		}
		return { ok: true, data: JSON.parse(text) as InviteLookup };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Accept an invitation: creates the account server-side and auto-logs in.
 * The resulting token pair is stored in the main process (never the renderer).
 */
export async function acceptInvite(
	token: string,
	displayName: string,
	password: string,
): Promise<{ ok: true; user: ServerUser } | { ok: false; error: string }> {
	const result = await serverFetch<TokenResponse>("/auth/invitations/accept", {
		token,
		display_name: displayName,
		password,
	});
	if (!result.ok) return result;
	applyTokens(result.data);
	return { ok: true, user: result.data.user };
}

export async function createInvite(payload: {
	email: string;
	role?: string;
	project_id?: string | null;
	project_role?: string | null;
}): Promise<
	{ ok: true; data: CreateInvitationResult } | { ok: false; error: string }
> {
	return authedFetch<CreateInvitationResult>(
		"/auth/invitations",
		"POST",
		payload,
	);
}

export async function listInvites(): Promise<
	{ ok: true; data: InvitationPublic[] } | { ok: false; error: string }
> {
	return authedFetch<InvitationPublic[]>("/auth/invitations", "GET");
}

export async function revokeInvite(
	invitationId: string,
): Promise<{ ok: true; data: { revoked: boolean } } | { ok: false; error: string }> {
	return authedFetch<{ revoked: boolean }>(
		`/auth/invitations/${encodeURIComponent(invitationId)}`,
		"DELETE",
	);
}

export async function loginLocal(
	email: string,
	password: string,
): Promise<{ ok: true; user: ServerUser } | { ok: false; error: string }> {
	const result = await serverFetch<TokenResponse>("/auth/login", {
		email,
		password,
	});
	if (!result.ok) return result;
	applyTokens(result.data);
	return { ok: true, user: result.data.user };
}

export async function loginWithEntraIdToken(
	idToken: string,
): Promise<{ ok: true; user: ServerUser } | { ok: false; error: string }> {
	const result = await serverFetch<TokenResponse>("/auth/oidc/exchange", {
		id_token: idToken,
	});
	if (!result.ok) return result;
	applyTokens(result.data);
	return { ok: true, user: result.data.user };
}

export async function refreshSession(): Promise<boolean> {
	if (!refreshToken) return false;
	const result = await serverFetch<TokenResponse>("/auth/refresh", {
		refresh_token: refreshToken,
	});
	if (!result.ok) {
		console.warn("[server-connection] Refresh failed:", result.error);
		clearSession();
		persist();
		return false;
	}
	applyTokens(result.data);
	return true;
}

export async function logout(): Promise<void> {
	if (refreshToken && serverUrl) {
		await serverFetch("/auth/logout", { refresh_token: refreshToken }).catch(
			() => undefined,
		);
	}
	clearSession();
	persist();
}

/**
 * Try to restore a session at startup from the persisted refresh token.
 */
export async function restoreSession(): Promise<boolean> {
	if (accessToken) return true; // already restored this run
	if (!isServerMode() || !refreshToken) return false;
	// Share a single in-flight refresh so a concurrent main + renderer restore
	// does not rotate the refresh token twice (the second call would fail).
	if (restoreInFlight) return restoreInFlight;
	restoreInFlight = refreshSession().finally(() => {
		restoreInFlight = null;
	});
	return restoreInFlight;
}

// ---------------------------------------------------------------------------
// Administration (multi-tenant console)
// ---------------------------------------------------------------------------
//
// Thin wrappers over the /admin API. They exist in the main process because
// that is where the access token lives — it is never handed to the renderer.
// Nothing here is a permission check: the server decides, and these calls
// simply surface its answer.

export interface PermissionDescriptor {
	key: string;
	domain: string;
	action: string;
	labelKey: string;
	descriptionKey: string;
	privileged: boolean;
}

export interface OrganizationSummary {
	id: string;
	name: string;
	slug: string;
	is_active: boolean;
	created_at: string;
	my_role?: string | null;
}

export interface MyPermissions {
	user_id: string;
	platform_role: string;
	is_platform_admin: boolean;
	org_id: string | null;
	org_role: string | null;
	permissions: string[];
	organizations: OrganizationSummary[];
}

export interface RoleSummary {
	id: string;
	org_id: string | null;
	slug: string;
	name: string;
	description: string;
	is_system: boolean;
	scope: string;
	permissions: string[];
}

export interface OrgMemberSummary {
	user_id: string;
	email: string;
	display_name: string;
	avatar_url?: string | null;
	role_id: string;
	role_slug: string;
	role_name: string;
	is_active: boolean;
	created_at: string;
}

export interface QuotaSummary {
	org_id: string;
	max_users: number | null;
	max_projects: number | null;
	max_concurrent_runs: number | null;
	monthly_token_budget: number | null;
	enforce_hard_stop: boolean;
	used_users: number;
	used_projects: number;
	used_concurrent_runs: number;
}

export interface AuditEntry {
	id: string;
	user_id: string | null;
	user_email?: string | null;
	org_id: string | null;
	project_id: string | null;
	action: string;
	payload: Record<string, unknown> | null;
	ip: string | null;
	created_at: string;
}

export interface SessionSummary {
	id: string;
	user_id: string;
	user_email?: string | null;
	user_agent: string | null;
	ip: string | null;
	created_at: string;
	expires_at: string;
}

export interface AdminOverview {
	org_id: string;
	org_name: string;
	users_total: number;
	users_active: number;
	projects_total: number;
	specs_total: number;
	runs_active: number;
	runs_queued: number;
	runs_24h: number;
	runs_failed_24h: number;
	run_success_rate_7d: number;
	quota: QuotaSummary;
	runs_by_day: Array<{ date: string; count: number }>;
	runs_by_status: Record<string, number>;
	top_users: Array<{ user_id: string; display_name: string; runs: number }>;
	recent_failures: Array<{
		run_id: string;
		phase: string;
		error: string;
		finished_at: string;
	}>;
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export function getActiveOrgId(): string | null {
	return activeOrgId;
}

/**
 * Choose which organization subsequent requests act in.
 *
 * Local only: it sets a header the server still validates. Selecting an
 * organization the user does not belong to simply has no effect — the server
 * falls back to one they do.
 */
export function setActiveOrg(orgId: string | null): void {
	activeOrgId = orgId;
}

export async function fetchMyPermissions(): Promise<Result<MyPermissions>> {
	const result = await authedFetch<MyPermissions>("/auth/me/permissions", "GET");
	if (result.ok && !activeOrgId && result.data.org_id) {
		// Adopt whichever organization the server resolved, so the header and
		// the server agree from the second request onward.
		activeOrgId = result.data.org_id;
	}
	return result;
}

export async function switchOrg(orgId: string): Promise<Result<true>> {
	const result = await authedFetch<{
		access_token: string;
		refresh_token: string;
		expires_in: number;
		user: ServerUser;
	}>("/auth/switch-org", "POST", { org_id: orgId });
	if (!result.ok) return result;
	// The new pair is bound to the chosen organization; adopting it keeps the
	// token and the header in step.
	accessToken = result.data.access_token;
	refreshToken = result.data.refresh_token;
	currentUser = result.data.user;
	activeOrgId = orgId;
	persist();
	return { ok: true, data: true };
}

export const adminApi = {
	permissions: () => authedFetch<PermissionDescriptor[]>("/admin/permissions", "GET"),
	listRoles: () => authedFetch<RoleSummary[]>("/admin/roles", "GET"),
	createRole: (body: {
		slug: string;
		name: string;
		description?: string;
		scope?: string;
		permissions: string[];
	}) => authedFetch<RoleSummary>("/admin/roles", "POST", body),
	updateRole: (
		roleId: string,
		body: { name?: string; description?: string; permissions?: string[] },
	) => authedFetch<RoleSummary>(`/admin/roles/${roleId}`, "PATCH", body),
	deleteRole: (roleId: string) =>
		authedFetch<{ deleted: boolean }>(`/admin/roles/${roleId}`, "DELETE"),

	listMembers: () => authedFetch<OrgMemberSummary[]>("/admin/members", "GET"),
	addMember: (body: { user_id: string; role_slug: string }) =>
		authedFetch<OrgMemberSummary>("/admin/members", "POST", body),
	updateMemberRole: (userId: string, roleSlug: string) =>
		authedFetch<OrgMemberSummary>(`/admin/members/${userId}`, "PATCH", {
			role_slug: roleSlug,
		}),
	removeMember: (userId: string) =>
		authedFetch<{ removed: boolean }>(`/admin/members/${userId}`, "DELETE"),

	listOrgs: () => authedFetch<OrganizationSummary[]>("/admin/orgs", "GET"),
	createOrg: (body: { name: string; slug: string }) =>
		authedFetch<OrganizationSummary>("/admin/orgs", "POST", body),
	updateOrg: (
		orgId: string,
		body: { name?: string; is_active?: boolean; disabled_permissions?: string[] },
	) => authedFetch<OrganizationSummary>(`/admin/orgs/${orgId}`, "PATCH", body),
	deleteOrg: (orgId: string) =>
		authedFetch<{ deleted: boolean }>(`/admin/orgs/${orgId}`, "DELETE"),

	listUsers: () => authedFetch<ServerUser[]>("/admin/users", "GET"),
	deactivateUser: (userId: string) =>
		authedFetch<ServerUser>(`/admin/users/${userId}/deactivate`, "POST"),
	activateUser: (userId: string) =>
		authedFetch<ServerUser>(`/admin/users/${userId}/activate`, "POST"),

	listSessions: () => authedFetch<SessionSummary[]>("/admin/sessions", "GET"),
	revokeSessions: (userId: string) =>
		authedFetch<{ revoked: number }>(`/admin/sessions/${userId}`, "DELETE"),

	getQuotas: () => authedFetch<QuotaSummary>("/admin/quotas", "GET"),
	setQuotas: (body: Partial<Omit<QuotaSummary, "org_id">>) =>
		authedFetch<QuotaSummary>("/admin/quotas", "PUT", body),

	listAudit: (params?: { action?: string; limit?: number; offset?: number }) => {
		const query = new URLSearchParams();
		if (params?.action) query.set("action", params.action);
		if (params?.limit) query.set("limit", String(params.limit));
		if (params?.offset) query.set("offset", String(params.offset));
		const suffix = query.toString() ? `?${query}` : "";
		return authedFetch<AuditEntry[]>(`/admin/audit${suffix}`, "GET");
	},

	overview: () => authedFetch<AdminOverview>("/admin/overview", "GET"),
};
