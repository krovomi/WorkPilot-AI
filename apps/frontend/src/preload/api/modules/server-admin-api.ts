/**
 * Server Admin API — renderer bridge for the administration console
 * (organizations, roles, permissions, members, sessions, quotas, audit).
 *
 * Every call is relayed to the server, which is the only authority on what the
 * caller may do. The permission list this exposes is for *presentation* — it
 * tells the UI what to hide so a user is not offered an action that would 403.
 */

import { invokeIpc } from "./ipc-utils";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

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

export interface GroupMemberSummary {
	user_id: string;
	email: string;
	display_name: string;
}

export interface GroupProjectSummary {
	project_id: string;
	name: string;
	role: string;
}

/** A group: its members inherit its organization role and its project roles. */
export interface GroupSummary {
	id: string;
	name: string;
	description: string;
	role_slug: string | null;
	role_name: string | null;
	members: GroupMemberSummary[];
	projects: GroupProjectSummary[];
	created_at: string;
}

export interface GroupProjectOption {
	id: string;
	name: string;
}

export type GroupProjectRole = "viewer" | "member" | "owner";

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

	listGroups: () => Promise<DataResult<GroupSummary[]>>;
	listGroupProjects: () => Promise<DataResult<GroupProjectOption[]>>;
	createGroup: (body: {
		name: string;
		description?: string;
		role_slug?: string;
	}) => Promise<DataResult<GroupSummary>>;
	/** `role_slug: ""` removes the group's organization role. */
	updateGroup: (
		groupId: string,
		body: { name?: string; description?: string; role_slug?: string },
	) => Promise<DataResult<GroupSummary>>;
	deleteGroup: (groupId: string) => Promise<DataResult<{ deleted: boolean }>>;
	setGroupMember: (
		groupId: string,
		userId: string,
		inGroup: boolean,
	) => Promise<DataResult<GroupSummary>>;
	/** A null role takes the project away from the group. */
	setGroupProjectRole: (
		groupId: string,
		projectId: string,
		role: GroupProjectRole | null,
	) => Promise<DataResult<GroupSummary>>;

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
	myPermissions: () => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_MY_PERMISSIONS),
	getActiveOrg: () => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_ACTIVE_ORG),
	setActiveOrg: (orgId) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_SET_ACTIVE_ORG, orgId),
	switchOrg: (orgId) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_SWITCH_ORG, orgId),

	permissions: () => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_PERMISSIONS),
	listRoles: () => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_LIST_ROLES),
	createRole: (body) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_CREATE_ROLE, body),
	updateRole: (roleId, body) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_UPDATE_ROLE, roleId, body),
	deleteRole: (roleId) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_DELETE_ROLE, roleId),

	listMembers: () => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_LIST_MEMBERS),
	addMember: (body) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_ADD_MEMBER, body),
	updateMemberRole: (userId, roleSlug) =>
		invokeIpc(IPC_CHANNELS.SERVER_ADMIN_UPDATE_MEMBER_ROLE, userId, roleSlug),
	removeMember: (userId) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_REMOVE_MEMBER, userId),

	listGroups: () => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_GROUPS_LIST),
	listGroupProjects: () => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_GROUPS_PROJECTS),
	createGroup: (body) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_GROUP_CREATE, body),
	updateGroup: (groupId, body) =>
		invokeIpc(IPC_CHANNELS.SERVER_ADMIN_GROUP_UPDATE, groupId, body),
	deleteGroup: (groupId) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_GROUP_DELETE, groupId),
	setGroupMember: (groupId, userId, inGroup) =>
		invokeIpc(IPC_CHANNELS.SERVER_ADMIN_GROUP_SET_MEMBER, groupId, userId, inGroup),
	setGroupProjectRole: (groupId, projectId, role) =>
		invokeIpc(IPC_CHANNELS.SERVER_ADMIN_GROUP_SET_PROJECT_ROLE, groupId, projectId, role),

	listOrgs: () => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_LIST_ORGS),
	createOrg: (body) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_CREATE_ORG, body),
	updateOrg: (orgId, body) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_UPDATE_ORG, orgId, body),
	deleteOrg: (orgId) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_DELETE_ORG, orgId),

	listUsers: () => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_LIST_USERS),
	deactivateUser: (userId) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_DEACTIVATE_USER, userId),
	activateUser: (userId) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_ACTIVATE_USER, userId),

	listSessions: () => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_LIST_SESSIONS),
	revokeSessions: (userId) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_REVOKE_SESSIONS, userId),

	getQuotas: () => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_GET_QUOTAS),
	setQuotas: (body) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_SET_QUOTAS, body),

	listAudit: (params) => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_LIST_AUDIT, params),

	overview: () => invokeIpc(IPC_CHANNELS.SERVER_ADMIN_OVERVIEW),
});
