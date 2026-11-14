/** The organization, its people and its roles, as the admin screens' tests use them. */

import { Alert } from "react-native";
import type { OrgMember, Role } from "../src/admin/types";

export const ALL = [
	"org.member.read",
	"org.member.write",
	"org.invitation.read",
	"org.invitation.write",
	"org.role.read",
	"org.role.write",
	"project.member.write",
];

export const member = (id: string, name: string, extra: Partial<OrgMember> = {}): OrgMember => ({
	user_id: id,
	email: `${id}@x.io`,
	display_name: name,
	role_id: "r-member",
	role_slug: "member",
	role_name: "Member",
	is_active: true,
	created_at: "2026-11-01T00:00:00Z",
	...extra,
});

export const role = (id: string, slug: string, name: string, extra: Partial<Role> = {}): Role => ({
	id,
	org_id: "org-a",
	slug,
	name,
	description: "",
	is_system: false,
	scope: "org",
	permissions: [],
	...extra,
});

export const ROLES = [
	role("r-admin", "admin", "Admin", { is_system: true, org_id: null, permissions: ["org.member.write"] }),
	role("r-member", "member", "Member", { is_system: true, org_id: null }),
	role("r-proj", "lead", "Lead", { scope: "project" }),
	role("r-qa", "qa", "QA", { description: "Testers", permissions: ["board.read"] }),
];

/** Confirm every alert with its destructive button. */
export function confirmAlerts() {
	return jest.spyOn(Alert, "alert").mockImplementation((_t, _b, buttons) => {
		void buttons?.find((b) => b.style === "destructive")?.onPress?.();
	});
}
