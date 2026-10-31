/**
 * IPC surface for the administration console (multi-user server mode).
 *
 * Every handler forwards to `server-connection`, which owns the access token —
 * the renderer never sees it. None of this is a permission check: the server
 * decides, and these channels only relay its answer, including its 403s.
 */

import { ipcMain } from "electron";
import {
	adminApi,
	fetchMyPermissions,
	getActiveOrgId,
	setActiveOrg,
	switchOrg,
} from "../server-connection";
import { groupsApi } from "../server-admin-groups";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

export function registerServerAdminHandlers(): void {
	// --- Effective permissions of the signed-in user ------------------------
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_MY_PERMISSIONS, async () => fetchMyPermissions());
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_ACTIVE_ORG, async () => ({
		ok: true as const,
		data: getActiveOrgId(),
	}));
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_SET_ACTIVE_ORG, async (_e, orgId: string | null) => {
		setActiveOrg(orgId);
		return { ok: true as const, data: getActiveOrgId() };
	});
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_SWITCH_ORG, async (_e, orgId: string) =>
		switchOrg(orgId),
	);

	// --- Catalog and roles ---------------------------------------------------
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_PERMISSIONS, async () => adminApi.permissions());
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_LIST_ROLES, async () => adminApi.listRoles());
	ipcMain.handle(
		IPC_CHANNELS.SERVER_ADMIN_CREATE_ROLE,
		async (
			_e,
			body: {
				slug: string;
				name: string;
				description?: string;
				scope?: string;
				permissions: string[];
			},
		) => adminApi.createRole(body),
	);
	ipcMain.handle(
		IPC_CHANNELS.SERVER_ADMIN_UPDATE_ROLE,
		async (
			_e,
			roleId: string,
			body: { name?: string; description?: string; permissions?: string[] },
		) => adminApi.updateRole(roleId, body),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_DELETE_ROLE, async (_e, roleId: string) =>
		adminApi.deleteRole(roleId),
	);

	// --- Members -------------------------------------------------------------
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_LIST_MEMBERS, async () => adminApi.listMembers());
	ipcMain.handle(
		IPC_CHANNELS.SERVER_ADMIN_ADD_MEMBER,
		async (_e, body: { user_id: string; role_slug: string }) =>
			adminApi.addMember(body),
	);
	ipcMain.handle(
		IPC_CHANNELS.SERVER_ADMIN_UPDATE_MEMBER_ROLE,
		async (_e, userId: string, roleSlug: string) =>
			adminApi.updateMemberRole(userId, roleSlug),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_REMOVE_MEMBER, async (_e, userId: string) =>
		adminApi.removeMember(userId),
	);

	// --- Groups: every argument is checked by groupsApi before any request ----
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_GROUPS_LIST, async () => groupsApi.list());
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_GROUPS_PROJECTS, async () => groupsApi.projects());
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_GROUP_CREATE, async (_e, body: unknown) =>
		groupsApi.create(body),
	);
	ipcMain.handle(
		IPC_CHANNELS.SERVER_ADMIN_GROUP_UPDATE,
		async (_e, groupId: unknown, body: unknown) => groupsApi.update(groupId, body),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_GROUP_DELETE, async (_e, groupId: unknown) =>
		groupsApi.remove(groupId),
	);
	ipcMain.handle(
		IPC_CHANNELS.SERVER_ADMIN_GROUP_SET_MEMBER,
		async (_e, groupId: unknown, userId: unknown, inGroup: unknown) =>
			groupsApi.setMember(groupId, userId, inGroup),
	);
	ipcMain.handle(
		IPC_CHANNELS.SERVER_ADMIN_GROUP_SET_PROJECT_ROLE,
		async (_e, groupId: unknown, projectId: unknown, role: unknown) =>
			groupsApi.setProjectRole(groupId, projectId, role),
	);

	// --- Organizations (platform administrators) -----------------------------
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_LIST_ORGS, async () => adminApi.listOrgs());
	ipcMain.handle(
		IPC_CHANNELS.SERVER_ADMIN_CREATE_ORG,
		async (_e, body: { name: string; slug: string }) => adminApi.createOrg(body),
	);
	ipcMain.handle(
		IPC_CHANNELS.SERVER_ADMIN_UPDATE_ORG,
		async (
			_e,
			orgId: string,
			body: { name?: string; is_active?: boolean; disabled_permissions?: string[] },
		) => adminApi.updateOrg(orgId, body),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_DELETE_ORG, async (_e, orgId: string) =>
		adminApi.deleteOrg(orgId),
	);

	// --- Users and sessions --------------------------------------------------
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_LIST_USERS, async () => adminApi.listUsers());
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_DEACTIVATE_USER, async (_e, userId: string) =>
		adminApi.deactivateUser(userId),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_ACTIVATE_USER, async (_e, userId: string) =>
		adminApi.activateUser(userId),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_LIST_SESSIONS, async () => adminApi.listSessions());
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_REVOKE_SESSIONS, async (_e, userId: string) =>
		adminApi.revokeSessions(userId),
	);

	// --- Quotas, audit, dashboard -------------------------------------------
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_GET_QUOTAS, async () => adminApi.getQuotas());
	ipcMain.handle(
		IPC_CHANNELS.SERVER_ADMIN_SET_QUOTAS,
		async (
			_e,
			body: {
				max_users?: number | null;
				max_projects?: number | null;
				max_concurrent_runs?: number | null;
				monthly_token_budget?: number | null;
				enforce_hard_stop?: boolean;
			},
		) => adminApi.setQuotas(body),
	);
	ipcMain.handle(
		IPC_CHANNELS.SERVER_ADMIN_LIST_AUDIT,
		async (_e, params?: { action?: string; limit?: number; offset?: number }) =>
			adminApi.listAudit(params),
	);
	ipcMain.handle(IPC_CHANNELS.SERVER_ADMIN_OVERVIEW, async () => adminApi.overview());
}
