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

export function registerServerAdminHandlers(): void {
	// --- Effective permissions of the signed-in user ------------------------
	ipcMain.handle("server-admin:my-permissions", async () => fetchMyPermissions());
	ipcMain.handle("server-admin:active-org", async () => ({
		ok: true as const,
		data: getActiveOrgId(),
	}));
	ipcMain.handle("server-admin:set-active-org", async (_e, orgId: string | null) => {
		setActiveOrg(orgId);
		return { ok: true as const, data: getActiveOrgId() };
	});
	ipcMain.handle("server-admin:switch-org", async (_e, orgId: string) =>
		switchOrg(orgId),
	);

	// --- Catalog and roles ---------------------------------------------------
	ipcMain.handle("server-admin:permissions", async () => adminApi.permissions());
	ipcMain.handle("server-admin:list-roles", async () => adminApi.listRoles());
	ipcMain.handle(
		"server-admin:create-role",
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
		"server-admin:update-role",
		async (
			_e,
			roleId: string,
			body: { name?: string; description?: string; permissions?: string[] },
		) => adminApi.updateRole(roleId, body),
	);
	ipcMain.handle("server-admin:delete-role", async (_e, roleId: string) =>
		adminApi.deleteRole(roleId),
	);

	// --- Members -------------------------------------------------------------
	ipcMain.handle("server-admin:list-members", async () => adminApi.listMembers());
	ipcMain.handle(
		"server-admin:add-member",
		async (_e, body: { user_id: string; role_slug: string }) =>
			adminApi.addMember(body),
	);
	ipcMain.handle(
		"server-admin:update-member-role",
		async (_e, userId: string, roleSlug: string) =>
			adminApi.updateMemberRole(userId, roleSlug),
	);
	ipcMain.handle("server-admin:remove-member", async (_e, userId: string) =>
		adminApi.removeMember(userId),
	);

	// --- Organizations (platform administrators) -----------------------------
	ipcMain.handle("server-admin:list-orgs", async () => adminApi.listOrgs());
	ipcMain.handle(
		"server-admin:create-org",
		async (_e, body: { name: string; slug: string }) => adminApi.createOrg(body),
	);
	ipcMain.handle(
		"server-admin:update-org",
		async (
			_e,
			orgId: string,
			body: { name?: string; is_active?: boolean; disabled_permissions?: string[] },
		) => adminApi.updateOrg(orgId, body),
	);
	ipcMain.handle("server-admin:delete-org", async (_e, orgId: string) =>
		adminApi.deleteOrg(orgId),
	);

	// --- Users and sessions --------------------------------------------------
	ipcMain.handle("server-admin:list-users", async () => adminApi.listUsers());
	ipcMain.handle("server-admin:deactivate-user", async (_e, userId: string) =>
		adminApi.deactivateUser(userId),
	);
	ipcMain.handle("server-admin:activate-user", async (_e, userId: string) =>
		adminApi.activateUser(userId),
	);
	ipcMain.handle("server-admin:list-sessions", async () => adminApi.listSessions());
	ipcMain.handle("server-admin:revoke-sessions", async (_e, userId: string) =>
		adminApi.revokeSessions(userId),
	);

	// --- Quotas, audit, dashboard -------------------------------------------
	ipcMain.handle("server-admin:get-quotas", async () => adminApi.getQuotas());
	ipcMain.handle(
		"server-admin:set-quotas",
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
		"server-admin:list-audit",
		async (_e, params?: { action?: string; limit?: number; offset?: number }) =>
			adminApi.listAudit(params),
	);
	ipcMain.handle("server-admin:overview", async () => adminApi.overview());
}
