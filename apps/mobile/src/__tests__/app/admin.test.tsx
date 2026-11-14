import { fireEvent, screen, waitFor, within } from "expo-router/testing-library";
import { Alert, Share } from "react-native";
import type { Group, Invitation, OrgMember, Role } from "../../admin/types";
import { type Call, fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

const ALL = [
	"org.member.read",
	"org.member.write",
	"org.invitation.read",
	"org.invitation.write",
	"org.role.read",
	"org.role.write",
	"project.member.write",
];

const member = (id: string, name: string, extra: Partial<OrgMember> = {}): OrgMember => ({
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

const role = (id: string, slug: string, name: string, extra: Partial<Role> = {}): Role => ({
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

const ROLES = [
	role("r-admin", "admin", "Admin", { is_system: true, org_id: null, permissions: ["org.member.write"] }),
	role("r-member", "member", "Member", { is_system: true, org_id: null }),
	role("r-proj", "lead", "Lead", { scope: "project" }),
	role("r-qa", "qa", "QA", { description: "Testers", permissions: ["board.read"] }),
];

/** Confirm every alert with its destructive button. */
function confirmAlerts() {
	return jest.spyOn(Alert, "alert").mockImplementation((_t, _b, buttons) => {
		void buttons?.find((b) => b.style === "destructive")?.onPress?.();
	});
}

afterEach(() => {
	restoreFetch();
	jest.restoreAllMocks();
});

describe("administration home", () => {
	it("lists only the pages the person may read, under the organization's name", async () => {
		fakeServer({}, ["org.member.read"]);
		const app = await openApp("/admin");
		expect(await screen.findByText("Organization: Acme")).toBeTruthy();
		expect(screen.getByText("Members")).toBeTruthy();
		expect(screen.getByText("Groups")).toBeTruthy();
		expect(screen.queryByText("Invitations")).toBeNull();
		expect(screen.queryByText("Roles")).toBeNull();
		await fireEvent.press(screen.getByText("Members"));
		await waitFor(() => expect(app.getPathname()).toBe("/admin/members"));
	});
});

describe("members", () => {
	it("shows each member, changes a role and removes someone, never the person themself", async () => {
		let members = [member("u1", "Ada Lovelace"), member("u2", "Bob", { is_active: false })];
		const server = fakeServer(
			{
				"GET /admin/members": () => members,
				"GET /admin/roles": ROLES,
				"PATCH /admin/members/u2": (call: Call) => {
					members = members.map((m) =>
						m.user_id === "u2" ? { ...m, role_slug: "qa", role_name: "QA" } : m,
					);
					return members.find((m) => m.user_id === call.path.split("/").pop());
				},
				"DELETE /admin/members/u2": () => {
					members = members.filter((m) => m.user_id !== "u2");
					return {};
				},
			},
			ALL,
		);
		confirmAlerts();
		await openApp("/admin/members");
		expect(await screen.findByText("Ada Lovelace (you)")).toBeTruthy();
		expect(screen.getByText("u2@x.io · Member · deactivated")).toBeTruthy();
		// The person cannot open their own row.
		expect(screen.getByRole("button", { name: /Ada Lovelace/ })).toBeDisabled();

		await fireEvent.press(screen.getByRole("button", { name: /Bob/ }));
		// Project roles are not offered organization-wide.
		expect(screen.queryByRole("radio", { name: "Lead" })).toBeNull();
		// Picking the current role sends nothing.
		await fireEvent.press(screen.getByRole("radio", { name: "Member" }));
		expect(server.called("PATCH /admin/members/u2")).toHaveLength(0);
		await fireEvent.press(screen.getByRole("radio", { name: "QA" }));
		await waitFor(() => expect(screen.getByText(/u2@x.io · QA/)).toBeTruthy());
		expect(server.called("PATCH /admin/members/u2")[0].body).toEqual({ role_slug: "qa" });

		await fireEvent.press(screen.getByRole("button", { name: "Remove from the organization" }));
		await waitFor(() => expect(screen.queryByText(/Bob/)).toBeNull());
		expect(Alert.alert).toHaveBeenCalledWith("Remove Bob?", expect.any(String), expect.any(Array));
	});

	it("offers no change without org.member.write, and says why a removal failed", async () => {
		fakeServer({ "GET /admin/members": [member("u1", "Ada Lovelace"), member("u2", "Bob")] }, ["org.member.read"]);
		await openApp("/admin/members");
		expect(await screen.findByRole("button", { name: /Bob/ })).toBeDisabled();
	});

	it("shows the server's refusal of a removal", async () => {
		fakeServer(
			{
				"GET /admin/members": [member("u1", "Ada Lovelace"), member("u2", "Bob")],
				"GET /admin/roles": reply(500, { detail: "roles down" }),
				"DELETE /admin/members/u2": reply(409, { detail: "last owner" }),
			},
			ALL,
		);
		confirmAlerts();
		await openApp("/admin/members");
		await fireEvent.press(await screen.findByRole("button", { name: /Bob/ }));
		// The roles could not be read: no role picker, the removal still offered.
		expect(screen.queryByRole("radio")).toBeNull();
		await fireEvent.press(screen.getByRole("button", { name: "Remove from the organization" }));
		expect(await screen.findByText(/last owner/)).toBeTruthy();
	});
});

describe("invitations", () => {
	const pending: Invitation = {
		id: "i1",
		email: "carol@x.io",
		role: "viewer",
		project_id: null,
		project_role: null,
		expires_at: "2026-11-21T00:00:00Z",
		created_at: "2026-11-14T00:00:00Z",
	};

	it("invites by email, shows the one-time link to share when no email went out, and revokes", async () => {
		let invitations: Invitation[] = [pending];
		const server = fakeServer(
			{
				"GET /auth/invitations": () => invitations,
				"POST /auth/invitations": (call: Call) => {
					const { email, role: r } = call.body as { email: string; role: string };
					const created = { ...pending, id: "i2", email, role: r, invite_link: "https://wp.example.com/i/tok", email_sent: false };
					invitations = [...invitations, created];
					return created;
				},
				"DELETE /auth/invitations/i1": () => {
					invitations = invitations.filter((i) => i.id !== "i1");
					return {};
				},
			},
			ALL,
		);
		const share = jest.spyOn(Share, "share").mockResolvedValue({ action: "sharedAction", activityType: undefined });
		confirmAlerts();
		await openApp("/admin/invitations");
		expect(await screen.findByText("1 pending invitation")).toBeTruthy();
		expect(screen.getByText("carol@x.io")).toBeTruthy();
		// A non-platform admin cannot make a server administrator.
		expect(screen.queryByRole("radio", { name: "Server administrator" })).toBeNull();

		const send = screen.getByRole("button", { name: "Invite" });
		expect(send).toBeDisabled();
		await fireEvent.changeText(screen.getByLabelText("Email"), " dan@x.io ");
		await fireEvent.press(screen.getByRole("radio", { name: "Viewer" }));
		await fireEvent.press(screen.getByRole("button", { name: "Invite" }));
		expect(
			await screen.findByText("No email went out to dan@x.io: share this link with them. It is shown only once."),
		).toBeTruthy();
		expect(server.called("POST /auth/invitations")[0].body).toEqual({ email: "dan@x.io", role: "viewer" });
		expect(screen.getByText("2 pending invitations")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "Share the link" }));
		expect(share).toHaveBeenCalledWith({ message: "https://wp.example.com/i/tok" });

		await fireEvent.press(screen.getAllByRole("button", { name: "Revoke" })[0]);
		await waitFor(() => expect(screen.getByText("1 pending invitation")).toBeTruthy());
		expect(screen.queryByText("carol@x.io")).toBeNull();
	});

	it("says the invitation was emailed, and offers a platform admin the server administrator role", async () => {
		fakeServer(
			{
				"GET /auth/invitations": [],
				"POST /auth/invitations": { ...pending, email: "eve@x.io", role: "admin", invite_link: "l", email_sent: true },
			},
			ALL,
			{ is_platform_admin: true },
		);
		await openApp("/admin/invitations");
		await fireEvent.changeText(await screen.findByLabelText("Email"), "eve@x.io");
		await fireEvent.press(screen.getByRole("radio", { name: "Server administrator" }));
		await fireEvent.press(screen.getByRole("button", { name: "Invite" }));
		expect(await screen.findByText("Invitation emailed to eve@x.io.")).toBeTruthy();
	});

	it("is read only without org.invitation.write, and keeps the address when the invite fails", async () => {
		fakeServer({ "GET /auth/invitations": [pending] }, ["org.invitation.read"]);
		await openApp("/admin/invitations");
		expect(await screen.findByText("carol@x.io")).toBeTruthy();
		expect(screen.queryByLabelText("Email")).toBeNull();
		expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
	});

	it("shows why an invitation was refused", async () => {
		fakeServer(
			{ "GET /auth/invitations": [], "POST /auth/invitations": reply(409, { detail: "already a member" }) },
			ALL,
		);
		await openApp("/admin/invitations");
		await fireEvent.changeText(await screen.findByLabelText("Email"), "ada@x.io");
		await fireEvent.press(screen.getByRole("button", { name: "Invite" }));
		expect(await screen.findByText(/already a member/)).toBeTruthy();
		expect(screen.getByDisplayValue("ada@x.io")).toBeTruthy();
	});
});

describe("groups", () => {
	const group = (extra: Partial<Group> = {}): Group => ({
		id: "g1",
		name: "Backend",
		description: "The API people",
		role_slug: null,
		role_name: null,
		members: [{ user_id: "u2", email: "u2@x.io", display_name: "Bob" }],
		projects: [{ project_id: "p1", name: "Shop", role: "member" }],
		created_at: "2026-11-01T00:00:00Z",
		...extra,
	});

	it("lists the groups, creates one and opens it", async () => {
		let groups = [group({ role_name: "QA" })];
		const server = fakeServer(
			{
				"GET /admin/groups": () => groups,
				"POST /admin/groups": (call: Call) => {
					const created = group({ id: "g2", name: (call.body as { name: string }).name, members: [], projects: [] });
					groups = [...groups, created];
					return created;
				},
			},
			ALL,
		);
		const app = await openApp("/admin/groups");
		expect(await screen.findByText("1 member · 1 project · QA")).toBeTruthy();
		await fireEvent.changeText(screen.getByLabelText("Name"), "  Mobile  ");
		await fireEvent.press(screen.getByRole("button", { name: "Create the group" }));
		expect(await screen.findByText("Mobile")).toBeTruthy();
		expect(server.called("POST /admin/groups")[0].body).toEqual({ name: "Mobile", description: "" });
		expect(screen.getByText("0 members · 0 projects")).toBeTruthy();

		await fireEvent.press(screen.getByText("Backend"));
		await waitFor(() => expect(app.getPathname()).toBe("/admin/groups/g1"));
	});

	it("says there is no group, and hides creation without org.member.write", async () => {
		fakeServer({ "GET /admin/groups": [] }, ["org.member.read"]);
		await openApp("/admin/groups");
		expect(await screen.findByText("No group yet.")).toBeTruthy();
		expect(screen.queryByLabelText("Name")).toBeNull();
	});

	it("edits a group: its role, its members, its projects, then deletes it", async () => {
		let current = group();
		const update = (changes: Partial<Group>) => {
			current = { ...current, ...changes };
			return current;
		};
		const server = fakeServer(
			{
				"GET /admin/groups": () => [current],
				"GET /admin/members": [member("u1", "Ada Lovelace"), member("u2", "Bob"), member("u3", "Carol")],
				"GET /admin/roles": ROLES,
				"GET /projects": [
					{ id: "p1", name: "Shop", repo_url: "", default_branch: "main" },
					{ id: "p2", name: "Blog", repo_url: "", default_branch: "main" },
				],
				"PATCH /admin/groups/g1": (call: Call) => update({ role_slug: (call.body as { role_slug: string }).role_slug }),
				"PUT /admin/groups/g1/members/u3": () =>
					update({ members: [...current.members, { user_id: "u3", email: "u3@x.io", display_name: "Carol" }] }),
				"DELETE /admin/groups/g1/members/u2": () => update({ members: current.members.filter((m) => m.user_id !== "u2") }),
				"PUT /admin/groups/g1/projects/p2": (call: Call) =>
					update({
						projects: [...current.projects, { project_id: "p2", name: "Blog", role: (call.body as { role: string }).role }],
					}),
				"DELETE /admin/groups/g1/projects/p1": () => update({ projects: current.projects.filter((p) => p.project_id !== "p1") }),
				"DELETE /admin/groups/g1": {},
			},
			ALL,
		);
		confirmAlerts();
		const app = await openApp("/admin/groups");
		await fireEvent.press(await screen.findByText("Backend"));
		expect(await screen.findByText("The API people")).toBeTruthy();

		// The organization role the group gives.
		await fireEvent.press(screen.getByRole("radio", { name: "QA" }));
		await waitFor(() => expect(server.called("PATCH /admin/groups/g1")).toHaveLength(1));
		expect(server.called("PATCH /admin/groups/g1")[0].body).toEqual({ role_slug: "qa" });
		await fireEvent.press(screen.getByRole("radio", { name: "No role from the group" }));
		await waitFor(() => expect(server.called("PATCH /admin/groups/g1")).toHaveLength(2));
		expect(server.called("PATCH /admin/groups/g1")[1].body).toEqual({ role_slug: "" });

		// Members: only people not yet in the group are offered.
		await fireEvent.press(screen.getByRole("button", { name: "Add a member" }));
		expect(screen.queryByRole("radio", { name: "Bob" })).toBeNull();
		await fireEvent.press(screen.getByRole("radio", { name: "Carol" }));
		expect(await screen.findByText("2 members")).toBeTruthy();
		const bobRow = screen.getByText("u2@x.io").parent?.parent;
		await fireEvent.press(within(bobRow as never).getByRole("button", { name: "Remove" }));
		expect(await screen.findByText("1 member")).toBeTruthy();

		// Projects: pick the role, then a project the group does not reach yet.
		await fireEvent.press(screen.getByRole("button", { name: "Give access to a project" }));
		expect(screen.queryByRole("radio", { name: "Shop" })).toBeNull();
		await fireEvent.press(screen.getByRole("radio", { name: "Viewer" }));
		await fireEvent.press(screen.getByRole("radio", { name: "Blog" }));
		expect(await screen.findByText("2 projects")).toBeTruthy();
		expect(server.called("PUT /admin/groups/g1/projects/p2")[0].body).toEqual({ role: "viewer" });
		const shopRow = screen.getByText("Shop").parent?.parent;
		await fireEvent.press(within(shopRow as never).getByRole("button", { name: "Remove" }));
		expect(await screen.findByText("1 project")).toBeTruthy();

		await fireEvent.press(screen.getByRole("button", { name: "Delete the group" }));
		await waitFor(() => expect(app.getPathname()).toBe("/admin/groups"));
		expect(server.called("DELETE /admin/groups/g1")).toHaveLength(1);
	});

	it("is read only without write permissions", async () => {
		fakeServer(
			{
				"GET /admin/groups": [group()],
				"GET /admin/members": [member("u1", "Ada Lovelace")],
				"GET /projects": [],
			},
			["org.member.read"],
		);
		await openApp("/admin/groups/g1");
		expect(await screen.findByText("Bob")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Add a member" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Give access to a project" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete the group" })).toBeNull();
		// No role picker without org.role.read.
		expect(screen.queryByText("Role in the organization")).toBeNull();
	});

	it("says a group no longer exists, and shows why an edit failed", async () => {
		fakeServer({ "GET /admin/groups": [], "GET /admin/members": [], "GET /projects": [] }, ALL);
		await openApp("/admin/groups/g9");
		expect(await screen.findByText("This group no longer exists.")).toBeTruthy();
	});

	it("shows the server's refusal of a deletion and stays on the group", async () => {
		fakeServer(
			{
				"GET /admin/groups": [group()],
				"GET /admin/members": [],
				"GET /admin/roles": ROLES,
				"GET /projects": [],
				"DELETE /admin/groups/g1": reply(409, { detail: "group in use" }),
			},
			ALL,
		);
		confirmAlerts();
		const app = await openApp("/admin/groups/g1");
		await fireEvent.press(await screen.findByRole("button", { name: "Delete the group" }));
		expect(await screen.findByText(/group in use/)).toBeTruthy();
		expect(app.getPathname()).toBe("/admin/groups/g1");
	});
});

describe("roles", () => {
	it("lists built-in roles first, then by scope and name, and opens a new role", async () => {
		fakeServer({ "GET /admin/roles": ROLES, "GET /admin/permissions": [] }, ALL);
		const app = await openApp("/admin/roles");
		await screen.findByText("Admin");
		const names = screen.getAllByRole("link").map((l) => within(l).getAllByText(/./)[0].props.children);
		expect(names).toEqual(["Admin", "Member", "QA", "Lead"]);
		expect(screen.getByText("Organization · built in · 1 permission")).toBeTruthy();
		expect(screen.getByText("Project · custom · 0 permissions")).toBeTruthy();
		await fireEvent.press(screen.getByRole("button", { name: "New role" }));
		await waitFor(() => expect(app.getPathname()).toBe("/admin/roles/new"));
	});

	it("hides New role without org.role.write, and shows a failed read", async () => {
		fakeServer({ "GET /admin/roles": reply(500, { detail: "roles down" }) }, ["org.role.read"]);
		await openApp("/admin/roles");
		expect(await screen.findByText(/roles down/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "New role" })).toBeNull();
	});

	const PERMISSIONS = [
		{ key: "board.read", domain: "board", action: "read", privileged: false },
		{ key: "board.write", domain: "board", action: "write", privileged: false },
		{ key: "org.member.write", domain: "org", action: "write", privileged: true },
	];

	it("creates a role from its name, with the permissions switched on", async () => {
		const server = fakeServer(
			{ "GET /admin/roles": ROLES, "GET /admin/permissions": PERMISSIONS, "POST /admin/roles": role("r9", "x", "x") },
			ALL,
		);
		const app = await openApp("/admin/roles");
		await fireEvent.press(await screen.findByRole("button", { name: "New role" }));
		const create = await screen.findByRole("button", { name: "Create the role" });
		expect(create).toBeDisabled();
		await fireEvent.changeText(screen.getByLabelText("Name"), " Équipe Mobile ");
		expect(screen.getByText("Identifier: equipe-mobile")).toBeTruthy();
		await fireEvent.changeText(screen.getByLabelText("Description"), " Phones ");
		expect(screen.getByText(/sensitive/)).toBeTruthy();
		await fireEvent(screen.getByLabelText("board.write"), "valueChange", true);
		await fireEvent(screen.getByLabelText("board.read"), "valueChange", true);
		await fireEvent(screen.getByLabelText("board.read"), "valueChange", false);
		await fireEvent(screen.getByLabelText("board.read"), "valueChange", true);
		await fireEvent.press(screen.getByRole("button", { name: "Create the role" }));
		await waitFor(() => expect(app.getPathname()).toBe("/admin/roles"));
		expect(server.called("POST /admin/roles")[0].body).toEqual({
			slug: "equipe-mobile",
			name: "Équipe Mobile",
			description: "Phones",
			permissions: ["board.read", "board.write"],
			scope: "org",
		});
	});

	it("edits and deletes a custom role", async () => {
		let roles = ROLES;
		const server = fakeServer(
			{
				"GET /admin/roles": () => roles,
				"GET /admin/permissions": PERMISSIONS,
				"PATCH /admin/roles/r-qa": (call: Call) => {
					roles = roles.map((r) => (r.id === "r-qa" ? { ...r, ...(call.body as Partial<Role>) } : r));
					return roles[3];
				},
				"DELETE /admin/roles/r-qa": {},
			},
			ALL,
		);
		confirmAlerts();
		const app = await openApp("/admin/roles");
		await fireEvent.press(await screen.findByText("QA"));
		expect(await screen.findByDisplayValue("Testers")).toBeTruthy();
		expect(screen.getByLabelText("board.read").props.value).toBe(true);
		await fireEvent.changeText(screen.getByLabelText("Name"), "Quality");
		await fireEvent(screen.getByLabelText("board.read"), "valueChange", false);
		await fireEvent.press(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(server.called("PATCH /admin/roles/r-qa")).toHaveLength(1));
		expect(server.called("PATCH /admin/roles/r-qa")[0].body).toEqual({
			name: "Quality",
			description: "Testers",
			permissions: [],
		});
		expect(app.getPathname()).toBe("/admin/roles/r-qa");

		await fireEvent.press(screen.getByRole("button", { name: "Delete the role" }));
		await waitFor(() => expect(app.getPathname()).toBe("/admin/roles"));
		expect(server.called("DELETE /admin/roles/r-qa")).toHaveLength(1);
	});

	it("shows a built-in role read only", async () => {
		fakeServer({ "GET /admin/roles": ROLES, "GET /admin/permissions": PERMISSIONS }, ALL);
		await openApp("/admin/roles/r-admin");
		expect(await screen.findByText("A built-in role can't be changed.")).toBeTruthy();
		expect(screen.getByLabelText("org.member.write").props.value).toBe(true);
		const toggle = screen.getByLabelText("org.member.write");
		expect(toggle.props.disabled ?? toggle.props.enabled === false).toBe(true);
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete the role" })).toBeNull();
	});

	it("says a role no longer exists, and shows the server's refusal to delete one", async () => {
		fakeServer({ "GET /admin/roles": [], "GET /admin/permissions": [] }, ALL);
		await openApp("/admin/roles/r-gone");
		expect(await screen.findByText("This role no longer exists.")).toBeTruthy();
		restoreFetch();

		fakeServer(
			{
				"GET /admin/roles": ROLES,
				"GET /admin/permissions": [],
				"DELETE /admin/roles/r-qa": reply(409, { detail: "still held by 2 members" }),
			},
			ALL,
		);
		confirmAlerts();
		await openApp("/admin/roles/r-qa");
		await fireEvent.press(await screen.findByRole("button", { name: "Delete the role" }));
		expect(await screen.findByText(/still held by 2 members/)).toBeTruthy();
	});
});
