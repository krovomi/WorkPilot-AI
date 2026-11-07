/** The administration routes' shapes (`server/schemas.py`, `server/routers/admin/`). */

export interface OrgMember {
	user_id: string;
	email: string;
	display_name: string;
	role_id: string;
	role_slug: string;
	role_name: string;
	is_active: boolean;
	created_at: string;
}

export interface Role {
	id: string;
	org_id: string | null;
	slug: string;
	name: string;
	description: string;
	is_system: boolean;
	/** "org" for an organization-wide role, "project" for a project one. */
	scope: string;
	permissions: string[];
}

export interface Permission {
	key: string;
	domain: string;
	action: string;
	privileged: boolean;
}

export interface Invitation {
	id: string;
	email: string;
	role: string;
	project_id: string | null;
	project_role: string | null;
	expires_at: string;
	created_at: string;
}

export interface CreatedInvitation extends Invitation {
	/** The one-time acceptance link, returned once, to share by hand when no email went out. */
	invite_link: string;
	email_sent: boolean;
}

export interface Group {
	id: string;
	name: string;
	description: string;
	role_slug: string | null;
	role_name: string | null;
	members: { user_id: string; email: string; display_name: string }[];
	projects: { project_id: string; name: string; role: string }[];
	created_at: string;
}

export const PROJECT_ROLES = ["owner", "member", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
