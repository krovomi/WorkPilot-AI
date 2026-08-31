/**
 * Server Admin API — renderer bridge for the administration console
 * (organizations, roles, permissions, members, sessions, quotas, audit).
 *
 * Every call is relayed to the server, which is the only authority on what the
 * caller may do. The permission list this exposes is for *presentation* — it
 * tells the UI what to hide so a user is not offered an action that would 403.
 */

import { invokeIpc } from "./ipc-utils";

export type DataResult<T> = { ok: true; data: T } | { ok: false; error: string };

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

export interface ServerAdminAPI {
	myPermissions: () => Promise<DataResult<MyPermissions>>;
	getActiveOrg: () => Promise<DataResult<string | null>>;
	setActiveOrg: (orgId: string | null) => Promise<DataResult<string | null>>;
	switchOrg: (orgId: string) => Promise<DataResult<true>>;

	permissions: () => Promise<DataResult<PermissionDescriptor[]>>;
	listRoles: () => Promise<DataResult<RoleSummary[]>>;
	createRole: (body: {
		slug: string;
		name: string;
		description?: string;
		scope?: string;
		permissions: string[];
	}) => Promise<DataResult<RoleSummary>>;
	updateRole: (
		roleId: string,
		body: { name?: string; description?: string; permissions?: string[] },
	) => Promise<DataResult<RoleSummary>>;
	deleteRole: (roleId: string) => Promise<DataResult<{ deleted: boolean }>>;

	listMembers: () => Promise<DataResult<OrgMemberSummary[]>>;
	addMember: (body: {
		user_id: string;
		role_slug: string;
	}) => Promise<DataResult<OrgMemberSummary>>;
	updateMemberRole: (
		userId: string,
		roleSlug: string,
	) => Promise<DataResult<OrgMemberSummary>>;
	removeMember: (userId: string) => Promise<DataResult<{ removed: boolean }>>;

	listOrgs: () => Promise<DataResult<OrganizationSummary[]>>;
	createOrg: (body: {
		name: string;
		slug: string;
	}) => Promise<DataResult<OrganizationSummary>>;
	updateOrg: (
		orgId: string,
		body: { name?: string; is_active?: boolean; disabled_permissions?: string[] },
	) => Promise<DataResult<OrganizationSummary>>;
	deleteOrg: (orgId: string) => Promise<DataResult<{ deleted: boolean }>>;

	listUsers: () => Promise<DataResult<OrgMemberSummary[]>>;
	deactivateUser: (userId: string) => Promise<DataResult<unknown>>;
	activateUser: (userId: string) => Promise<DataResult<unknown>>;

	listSessions: () => Promise<DataResult<SessionSummary[]>>;
	revokeSessions: (userId: string) => Promise<DataResult<{ revoked: number }>>;

	getQuotas: () => Promise<DataResult<QuotaSummary>>;
	setQuotas: (body: {
		max_users?: number | null;
		max_projects?: number | null;
		max_concurrent_runs?: number | null;
		monthly_token_budget?: number | null;
		enforce_hard_stop?: boolean;
	}) => Promise<DataResult<QuotaSummary>>;

	listAudit: (params?: {
		action?: string;
		limit?: number;
		offset?: number;
	}) => Promise<DataResult<AuditEntry[]>>;

	overview: () => Promise<DataResult<AdminOverview>>;
}

export const createServerAdminAPI = (): ServerAdminAPI => ({
	myPermissions: () => invokeIpc("server-admin:my-permissions"),
	getActiveOrg: () => invokeIpc("server-admin:active-org"),
	setActiveOrg: (orgId) => invokeIpc("server-admin:set-active-org", orgId),
	switchOrg: (orgId) => invokeIpc("server-admin:switch-org", orgId),

	permissions: () => invokeIpc("server-admin:permissions"),
	listRoles: () => invokeIpc("server-admin:list-roles"),
	createRole: (body) => invokeIpc("server-admin:create-role", body),
	updateRole: (roleId, body) => invokeIpc("server-admin:update-role", roleId, body),
	deleteRole: (roleId) => invokeIpc("server-admin:delete-role", roleId),

	listMembers: () => invokeIpc("server-admin:list-members"),
	addMember: (body) => invokeIpc("server-admin:add-member", body),
	updateMemberRole: (userId, roleSlug) =>
		invokeIpc("server-admin:update-member-role", userId, roleSlug),
	removeMember: (userId) => invokeIpc("server-admin:remove-member", userId),

	listOrgs: () => invokeIpc("server-admin:list-orgs"),
	createOrg: (body) => invokeIpc("server-admin:create-org", body),
	updateOrg: (orgId, body) => invokeIpc("server-admin:update-org", orgId, body),
	deleteOrg: (orgId) => invokeIpc("server-admin:delete-org", orgId),

	listUsers: () => invokeIpc("server-admin:list-users"),
	deactivateUser: (userId) => invokeIpc("server-admin:deactivate-user", userId),
	activateUser: (userId) => invokeIpc("server-admin:activate-user", userId),

	listSessions: () => invokeIpc("server-admin:list-sessions"),
	revokeSessions: (userId) => invokeIpc("server-admin:revoke-sessions", userId),

	getQuotas: () => invokeIpc("server-admin:get-quotas"),
	setQuotas: (body) => invokeIpc("server-admin:set-quotas", body),

	listAudit: (params) => invokeIpc("server-admin:list-audit", params),

	overview: () => invokeIpc("server-admin:overview"),
});
