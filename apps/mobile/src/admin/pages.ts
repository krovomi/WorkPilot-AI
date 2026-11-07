/** What the person may administer in the organization they act in, and the permission each page reads with. */
export const ADMIN_PAGES = [
	{ page: "members", permission: "org.member.read" },
	{ page: "invitations", permission: "org.invitation.read" },
	{ page: "groups", permission: "org.member.read" },
	{ page: "roles", permission: "org.role.read" },
] as const;

export type AdminPage = (typeof ADMIN_PAGES)[number];

/** The pages this person sees: those their permissions read. */
export function visiblePages(can: (permission: string) => boolean): AdminPage[] {
	return ADMIN_PAGES.filter((p) => can(p.permission));
}

/**
 * The platform roles an invitation can give (`GlobalRole`), as on the
 * desktop. `admin` makes a server administrator, who reaches every
 * organization: the server lets only a platform admin give it
 * (`routers/invitations.py`), so only a platform admin is offered it.
 */
export function invitationRoles(isPlatformAdmin: boolean): string[] {
	return isPlatformAdmin ? ["member", "viewer", "admin"] : ["member", "viewer"];
}
