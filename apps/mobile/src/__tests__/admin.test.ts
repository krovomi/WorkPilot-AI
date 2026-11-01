import type { ServerClient } from "../api/client";
import { adminApi, byDomain, orgRoles, slugify } from "../admin/api";
import { invitationRoles, visiblePages } from "../admin/pages";
import type { Permission, Role } from "../admin/types";

function role(over: Partial<Role>): Role {
	return { id: "r", org_id: null, slug: "r", name: "R", description: "", is_system: true, scope: "org", permissions: [], ...over };
}

describe("administration helpers", () => {
	it("types a role identifier the server accepts from its name", () => {
		expect(slugify("Équipe QA (Paris)")).toBe("equipe-qa-paris");
		expect(slugify("  --Release managers--  ")).toBe("release-managers");
		expect(slugify("x".repeat(80))).toHaveLength(60);
		for (const name of ["Équipe QA", "a1 b2", "Ops"]) expect(slugify(name)).toMatch(/^[a-z0-9][a-z0-9-]*$/);
	});

	it("offers only organization-wide roles, the built-in ones first", () => {
		const roles = [
			role({ id: "c", slug: "custom", name: "Zeta", is_system: false, org_id: "o" }),
			role({ id: "p", slug: "viewer", name: "Viewer", scope: "project" }),
			role({ id: "a", slug: "admin", name: "Admin" }),
			role({ id: "b", slug: "auditors", name: "Auditors", is_system: false, org_id: "o" }),
		];
		expect(orgRoles(roles).map((r) => r.id)).toEqual(["a", "b", "c"]);
	});

	it("groups permissions by domain in the server's order", () => {
		const p = (key: string): Permission => ({ key, domain: key.split(".")[0], action: "x", privileged: false });
		expect(byDomain([p("task.read"), p("org.member.read"), p("task.write")])).toEqual([
			{ domain: "task", permissions: [p("task.read"), p("task.write")] },
			{ domain: "org", permissions: [p("org.member.read")] },
		]);
	});
});

describe("administration routes", () => {
	const request = jest.fn().mockResolvedValue({});
	const admin = adminApi({ request } as unknown as ServerClient);
	afterEach(() => request.mockClear());

	it("names ids in the path, encoded, and never sends a path of the server", async () => {
		await admin.setMemberRole("u/1", "admin");
		expect(request).toHaveBeenLastCalledWith("PATCH", "/admin/members/u%2F1", { role_slug: "admin" });
		await admin.addGroupMember("g1", "u 2");
		expect(request).toHaveBeenLastCalledWith("PUT", "/admin/groups/g1/members/u%202");
		await admin.setGroupProject("g1", "p1", "viewer");
		expect(request).toHaveBeenLastCalledWith("PUT", "/admin/groups/g1/projects/p1", { role: "viewer" });
		await admin.revokeInvitation("i1");
		expect(request).toHaveBeenLastCalledWith("DELETE", "/auth/invitations/i1");
	});

	it("creates organization roles only", async () => {
		await admin.createRole({ slug: "qa", name: "QA", description: "", permissions: ["task.read"] });
		expect(request).toHaveBeenLastCalledWith("POST", "/admin/roles", {
			slug: "qa",
			name: "QA",
			description: "",
			permissions: ["task.read"],
			scope: "org",
		});
	});

	it("invites with an organization role", async () => {
		await admin.invite("bob@x.io", "member");
		expect(request).toHaveBeenLastCalledWith("POST", "/auth/invitations", { email: "bob@x.io", role: "member" });
	});
});

describe("administration pages", () => {
	it("follows each page's read permission", () => {
		expect(visiblePages(() => true).map((p) => p.page)).toEqual(["members", "invitations", "groups", "roles"]);
		expect(visiblePages((p) => p === "org.role.read").map((p) => p.page)).toEqual(["roles"]);
		expect(visiblePages(() => false)).toEqual([]);
	});

	it("offers to invite a server administrator to a platform admin only", () => {
		expect(invitationRoles(false)).toEqual(["member", "viewer"]);
		expect(invitationRoles(true)).toEqual(["member", "viewer", "admin"]);
	});
});
