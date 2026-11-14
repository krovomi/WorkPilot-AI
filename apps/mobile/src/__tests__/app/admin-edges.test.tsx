/** What the admin screens do when a read or a write fails, or the data is thinner than usual. */

import { fireEvent, screen, waitFor } from "expo-router/testing-library";
import type { Group } from "../../admin/types";
import { ALL, confirmAlerts, member, ROLES } from "../../../test-support/admin-fixtures";
import { fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

afterEach(() => {
	restoreFetch();
	jest.restoreAllMocks();
});

const group = (extra: Partial<Group> = {}): Group => ({
	id: "g1",
	name: "Backend",
	description: "",
	role_slug: null,
	role_name: null,
	members: [],
	projects: [],
	created_at: "2026-11-01T00:00:00Z",
	...extra,
});

it("names no organization when the server does not list the current one", async () => {
	fakeServer({}, ["org.member.read"], { organizations: [{ id: "org-b", name: "Other" }] });
	await openApp("/admin");
	expect(await screen.findByText("Members")).toBeTruthy();
	expect(screen.queryByText(/Organization:/)).toBeNull();
});

describe("members", () => {
	it("folds a row back, and keeps the role when the server refuses the change", async () => {
		fakeServer(
			{
				"GET /admin/members": [member("u1", "Ada Lovelace"), member("u2", "Bob")],
				"GET /admin/roles": ROLES,
				"PATCH /admin/members/u2": reply(409, { detail: "last admin" }),
			},
			ALL,
		);
		await openApp("/admin/members");
		const bob = await screen.findByRole("button", { name: /Bob/ });
		await fireEvent.press(bob);
		await fireEvent.press(screen.getByRole("radio", { name: "QA" }));
		expect(await screen.findByText(/last admin/)).toBeTruthy();
		expect(screen.getByText("u2@x.io · Member")).toBeTruthy();
		await fireEvent.press(bob);
		expect(screen.queryByRole("radio")).toBeNull();
	});
});

describe("invitations", () => {
	it("counts no invitation when they cannot be read, and keeps one whose revocation failed", async () => {
		fakeServer({ "GET /auth/invitations": reply(500, { detail: "invitations down" }) }, ALL);
		await openApp("/admin/invitations");
		expect(await screen.findByText(/invitations down/)).toBeTruthy();
		expect(screen.getByText("0 pending invitations")).toBeTruthy();
		restoreFetch();

		fakeServer(
			{
				"GET /auth/invitations": [
					{
						id: "i1",
						email: "carol@x.io",
						role: "viewer",
						project_id: null,
						project_role: null,
						expires_at: "2026-11-21T00:00:00Z",
						created_at: "2026-11-14T00:00:00Z",
					},
				],
				"DELETE /auth/invitations/i1": reply(404, { detail: "already used" }),
			},
			ALL,
		);
		confirmAlerts();
		await openApp("/admin/invitations");
		await fireEvent.press(await screen.findByRole("button", { name: "Revoke" }));
		expect(await screen.findByText(/already used/)).toBeTruthy();
		expect(screen.getByText("carol@x.io")).toBeTruthy();
	});
});

describe("groups", () => {
	it("shows a failed read, and keeps the name when the creation is refused", async () => {
		fakeServer(
			{ "GET /admin/groups": reply(500, { detail: "groups down" }), "POST /admin/groups": reply(409, { detail: "taken" }) },
			ALL,
		);
		await openApp("/admin/groups");
		expect(await screen.findByText(/groups down/)).toBeTruthy();
		await fireEvent.changeText(screen.getByLabelText("Name"), "Backend");
		await fireEvent.press(screen.getByRole("button", { name: "Create the group" }));
		expect(await screen.findByText(/taken/)).toBeTruthy();
		expect(screen.getByDisplayValue("Backend")).toBeTruthy();
	});

	it("shows a group without a description, and keeps its role when the change is refused", async () => {
		const server = fakeServer(
			{
				"GET /admin/groups": [group()],
				"GET /admin/members": [],
				"GET /admin/roles": ROLES,
				"GET /projects": [],
				"PATCH /admin/groups/g1": reply(409, { detail: "role gone" }),
			},
			ALL,
		);
		await openApp("/admin/groups/g1");
		await fireEvent.press(await screen.findByRole("radio", { name: "QA" }));
		expect(await screen.findByText(/role gone/)).toBeTruthy();
		// Refused: the group was not read again.
		expect(server.called("GET /admin/groups")).toHaveLength(1);
		expect(screen.getByRole("radio", { name: "No role from the group" })).toBeSelected();
	});
});

describe("roles", () => {
	const PERMISSIONS = [{ key: "board.read", domain: "board", action: "read", privileged: false }];

	it("shows why a role could not be read", async () => {
		fakeServer({ "GET /admin/roles": reply(500, { detail: "roles down" }), "GET /admin/permissions": [] }, ALL);
		await openApp("/admin/roles/r-qa");
		expect(await screen.findByText(/roles down/)).toBeTruthy();
		expect(screen.queryByText("This role no longer exists.")).toBeNull();
	});

	it("shows a custom role read only, with its description, to someone who cannot change roles", async () => {
		fakeServer({ "GET /admin/roles": ROLES, "GET /admin/permissions": PERMISSIONS }, ["org.role.read"]);
		await openApp("/admin/roles/r-qa");
		expect(await screen.findByText("Testers")).toBeTruthy();
		expect(screen.queryByText("A built-in role can't be changed.")).toBeNull();
		expect(screen.queryByLabelText("Name")).toBeNull();
	});

	it("offers no permission to grant a new role when they cannot be read", async () => {
		fakeServer({ "GET /admin/roles": ROLES, "GET /admin/permissions": reply(500, { detail: "catalog down" }) }, ALL);
		await openApp("/admin/roles/new");
		expect(await screen.findByText(/catalog down/)).toBeTruthy();
		expect(screen.getByLabelText("Name")).toBeTruthy();
		expect(screen.queryByLabelText("board.read")).toBeNull();
	});

	it("stays on the role, with the edit, when the server refuses to save it", async () => {
		fakeServer(
			{
				"GET /admin/roles": ROLES,
				"GET /admin/permissions": PERMISSIONS,
				"PATCH /admin/roles/r-qa": reply(422, { detail: "name too long" }),
			},
			ALL,
		);
		const app = await openApp("/admin/roles/r-qa");
		await fireEvent.changeText(await screen.findByLabelText("Name"), "Quality");
		await fireEvent.press(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText(/name too long/)).toBeTruthy();
		await waitFor(() => expect(app.getPathname()).toBe("/admin/roles/r-qa"));
		expect(screen.getByDisplayValue("Quality")).toBeTruthy();
	});
});
