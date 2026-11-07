/**
 * The organization's administration, as the desktop app's Administration
 * view drives it: members, invitations, groups and roles of the organization
 * the person acts in (the `X-WorkPilot-Org` header). Each route checks its
 * own permission on the server; the app only hides what it would refuse.
 */

import { useMemo } from "react";
import type { ServerClient } from "../api/client";
import { useSession } from "../auth/session";
import type { CreatedInvitation, Group, Invitation, OrgMember, Permission, ProjectRole, Role } from "./types";

const enc = encodeURIComponent;

export interface RoleChanges {
	name?: string;
	description?: string;
	permissions?: string[];
}

export function adminApi(client: ServerClient) {
	return {
		members: () => client.request<OrgMember[]>("GET", "/admin/members"),
		setMemberRole: (userId: string, roleSlug: string) =>
			client.request<OrgMember>("PATCH", `/admin/members/${enc(userId)}`, { role_slug: roleSlug }),
		removeMember: (userId: string) => client.request("DELETE", `/admin/members/${enc(userId)}`),

		invitations: () => client.request<Invitation[]>("GET", "/auth/invitations"),
		invite: (email: string, role: string) =>
			client.request<CreatedInvitation>("POST", "/auth/invitations", { email, role }),
		revokeInvitation: (id: string) => client.request("DELETE", `/auth/invitations/${enc(id)}`),

		groups: () => client.request<Group[]>("GET", "/admin/groups"),
		createGroup: (name: string, description: string) =>
			client.request<Group>("POST", "/admin/groups", { name, description }),
		updateGroup: (id: string, changes: { name?: string; description?: string; role_slug?: string }) =>
			client.request<Group>("PATCH", `/admin/groups/${enc(id)}`, changes),
		deleteGroup: (id: string) => client.request("DELETE", `/admin/groups/${enc(id)}`),
		addGroupMember: (id: string, userId: string) =>
			client.request<Group>("PUT", `/admin/groups/${enc(id)}/members/${enc(userId)}`),
		removeGroupMember: (id: string, userId: string) =>
			client.request<Group>("DELETE", `/admin/groups/${enc(id)}/members/${enc(userId)}`),
		setGroupProject: (id: string, projectId: string, role: ProjectRole) =>
			client.request<Group>("PUT", `/admin/groups/${enc(id)}/projects/${enc(projectId)}`, { role }),
		removeGroupProject: (id: string, projectId: string) =>
			client.request<Group>("DELETE", `/admin/groups/${enc(id)}/projects/${enc(projectId)}`),

		roles: () => client.request<Role[]>("GET", "/admin/roles"),
		permissions: () => client.request<Permission[]>("GET", "/admin/permissions"),
		createRole: (role: { slug: string; name: string; description: string; permissions: string[] }) =>
			client.request<Role>("POST", "/admin/roles", { ...role, scope: "org" }),
		updateRole: (id: string, changes: RoleChanges) =>
			client.request<Role>("PATCH", `/admin/roles/${enc(id)}`, changes),
		deleteRole: (id: string) => client.request("DELETE", `/admin/roles/${enc(id)}`),
	};
}

export type AdminApi = ReturnType<typeof adminApi>;

/** The administration api of the signed-in session, the same object while the session lasts. */
export function useAdminApi(): AdminApi {
	const { client } = useSession();
	const api = useMemo(() => (client ? adminApi(client) : null), [client]);
	if (!api) throw new Error("useAdminApi without a session");
	return api;
}

/** A role slug as it is typed from a name: lowercase letters, digits and dashes. */
export function slugify(name: string): string {
	return name
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

/** Roles that can be given organization-wide, the built-in ones first. */
export function orgRoles(roles: Role[]): Role[] {
	return roles
		.filter((r) => r.scope === "org")
		.sort((a, b) => Number(b.is_system) - Number(a.is_system) || a.name.localeCompare(b.name));
}

/** Permissions grouped by domain, in the server's order. */
export function byDomain(permissions: Permission[]): { domain: string; permissions: Permission[] }[] {
	const groups = new Map<string, Permission[]>();
	for (const p of permissions) groups.set(p.domain, [...(groups.get(p.domain) ?? []), p]);
	return [...groups].map(([domain, list]) => ({ domain, permissions: list }));
}
