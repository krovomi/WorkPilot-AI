/** @vitest-environment jsdom */
/**
 * The administration console as an administrator uses it: the tabs their
 * permissions allow, each tab's data from the server bridge, and the changes
 * they make sent back through it.
 */
import "@testing-library/jest-dom/vitest";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import { useAdminStore } from "@/stores/admin-store";
import { usePermissionsStore } from "@/stores/permissions-store";
import { useServerSessionStore } from "@/stores/server-session-store";
import { AdministrationView } from "../AdministrationView";
import { AuditTab } from "../AuditTab";
import { MembersTab } from "../MembersTab";
import { OrganizationsTab } from "../OrganizationsTab";
import { OverviewTab } from "../OverviewTab";
import { QuotasTab } from "../QuotasTab";
import { RolesTab } from "../RolesTab";

vi.mock("@/components/auth/InvitationsAdmin", () => ({
	InvitationsAdmin: () => <p>invitations-panel</p>,
}));

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
const refused = (error: string) => Promise.resolve({ ok: false as const, error });

const QUOTA = {
	org_id: "o1",
	max_users: 10,
	max_projects: null,
	max_concurrent_runs: 2,
	monthly_token_budget: null,
	enforce_hard_stop: false,
	used_users: 3,
	used_projects: 4,
	used_concurrent_runs: 2,
};

const OVERVIEW = {
	org_id: "o1",
	org_name: "Acme",
	users_total: 5,
	users_active: 4,
	projects_total: 7,
	specs_total: 12,
	runs_active: 1,
	runs_queued: 2,
	runs_24h: 9,
	runs_failed_24h: 0,
	run_success_rate_7d: 0.876,
	quota: QUOTA,
	runs_by_day: [
		{ date: "2026-11-15", count: 0 },
		{ date: "2026-11-16", count: 4 },
	],
	runs_by_status: {},
	top_users: [],
	recent_failures: [],
};

const ROLES = [
	{
		id: "r-admin",
		org_id: null,
		slug: "admin",
		name: "Admin",
		description: "",
		is_system: true,
		scope: "org",
		permissions: ["org.member.read"],
	},
	{
		id: "r-lead",
		org_id: "o1",
		slug: "lead",
		name: "Lead",
		description: "",
		is_system: false,
		scope: "org",
		permissions: ["board.read"],
	},
];

const PERMISSIONS = [
	{ key: "board.read", domain: "board", action: "read", labelKey: "", descriptionKey: "", privileged: false },
	{ key: "board.run", domain: "board", action: "run", labelKey: "", descriptionKey: "", privileged: true },
	{ key: "org.member.read", domain: "org", action: "member.read", labelKey: "", descriptionKey: "", privileged: false },
];

const member = (user_id: string, over = {}) => ({
	user_id,
	email: `${user_id}@example.test`,
	display_name: user_id.toUpperCase(),
	role_id: "r-lead",
	role_slug: "lead",
	role_name: "Lead",
	is_active: true,
	created_at: "2026-11-01T00:00:00Z",
	...over,
});

const org = (id: string, over = {}) => ({
	id,
	name: `Org ${id}`,
	slug: id,
	is_active: true,
	created_at: "2026-11-01T00:00:00Z",
	...over,
});

const bridge = {
	myPermissions: vi.fn(),
	switchOrg: vi.fn(),
	overview: vi.fn(),
	permissions: vi.fn(),
	listRoles: vi.fn(),
	listMembers: vi.fn(),
	listOrgs: vi.fn(),
	listSessions: vi.fn(),
	getQuotas: vi.fn(),
	setQuotas: vi.fn(),
	listAudit: vi.fn(),
	listGroups: vi.fn(),
	listGroupProjects: vi.fn(),
	createRole: vi.fn(),
	updateRole: vi.fn(),
	deleteRole: vi.fn(),
	updateMemberRole: vi.fn(),
	addMember: vi.fn(),
	removeMember: vi.fn(),
	activateUser: vi.fn(),
	deactivateUser: vi.fn(),
	revokeSessions: vi.fn(),
	createOrg: vi.fn(),
	updateOrg: vi.fn(),
};

function grant(permissions: string[], over: Record<string, unknown> = {}): void {
	usePermissionsStore.setState({
		loaded: true,
		unrestricted: false,
		isPlatformAdmin: false,
		orgId: "o1",
		organizations: [],
		permissions: new Set(permissions),
		...over,
	});
}

beforeEach(() => {
	for (const fn of Object.values(bridge)) fn.mockReset();
	bridge.overview.mockImplementation(() => ok(OVERVIEW));
	bridge.permissions.mockImplementation(() => ok(PERMISSIONS));
	bridge.listRoles.mockImplementation(() => ok(ROLES));
	bridge.listMembers.mockImplementation(() => ok([]));
	bridge.listOrgs.mockImplementation(() => ok([]));
	bridge.listSessions.mockImplementation(() => ok([]));
	bridge.getQuotas.mockImplementation(() => ok(QUOTA));
	bridge.listAudit.mockImplementation(() => ok([]));
	bridge.listGroups.mockImplementation(() => ok([]));
	bridge.listGroupProjects.mockImplementation(() => ok([]));
	(globalThis as { electronAPI?: unknown }).electronAPI = { serverAdmin: bridge };
	useAdminStore.setState({
		overview: null,
		permissions: [],
		roles: [],
		members: [],
		organizations: [],
		sessions: [],
		quotas: null,
		audit: [],
		groups: [],
		groupProjects: [],
		loading: {},
		error: null,
	});
	useServerSessionStore.setState({ mode: "server" });
	grant([]);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("AdministrationView", () => {
	it("says there is nothing to administer in local mode", () => {
		useServerSessionStore.setState({ mode: "local" });
		render(<AdministrationView />);
		expect(screen.getByText("Nothing to administer in local mode")).toBeInTheDocument();
		expect(screen.queryByRole("navigation")).toBeNull();
	});

	it("loads the permissions once, then says when no section is allowed", async () => {
		usePermissionsStore.setState({ loaded: false });
		bridge.myPermissions.mockImplementation(() =>
			ok({
				user_id: "u1",
				platform_role: "user",
				is_platform_admin: false,
				org_id: null,
				org_role: null,
				permissions: [],
				organizations: [],
			}),
		);
		render(<AdministrationView />);
		expect(
			await screen.findByText("You do not have access to any administration section."),
		).toBeInTheDocument();
		expect(bridge.myPermissions).toHaveBeenCalledOnce();
	});

	it("shows only the tabs a permission allows, and switches between them", async () => {
		grant(["org.member.read", "audit.read"]);
		render(<AdministrationView />);
		const tabs = within(screen.getByRole("navigation")).getAllByRole("button");
		expect(tabs.map((tab) => tab.textContent)).toEqual(["Members", "Groups", "Audit"]);
		// Overview is not allowed: the first allowed tab opens instead.
		expect(await screen.findByText("No members yet.")).toBeInTheDocument();
		expect(bridge.overview).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Audit" }));
		expect(await screen.findByText("No administrative events recorded yet.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Groups" }));
		expect(await screen.findByText("No groups yet.")).toBeInTheDocument();
	});

	it("opens every tab for a platform administrator", async () => {
		grant([], { isPlatformAdmin: true, orgId: null, organizations: [org("o1"), org("o2")] });
		render(<AdministrationView />);
		// Not in any organization yet: the picker still renders, on the first one.
		expect(screen.getByLabelText("Current")).toHaveValue("o1");
		const names = ["Members", "Roles & permissions", "Organizations", "Invitations", "Quotas"];
		for (const name of names) fireEvent.click(screen.getByRole("button", { name }));
		expect(await screen.findByText("Maximum members")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Invitations" }));
		expect(screen.getByText("invitations-panel")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Overview" }));
		expect(await screen.findByText("Active runs")).toBeInTheDocument();
	});

	it("shows an unrestricted user every tenant tab but not the platform one", () => {
		grant([], { unrestricted: true });
		render(<AdministrationView />);
		const tabs = within(screen.getByRole("navigation")).getAllByRole("button");
		expect(tabs).toHaveLength(8);
		expect(screen.queryByRole("button", { name: "Organizations" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Usage" }));
		// No usage bridge in this world: the tab stays on its loading line.
		expect(screen.getByText("Loading…")).toBeInTheDocument();
	});

	it("shows a store error and lets it be dismissed", async () => {
		grant(["analytics.read"]);
		bridge.overview.mockImplementation(() => refused("server is down"));
		render(<AdministrationView />);
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("server is down");
		fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("switches organization, reloads the open tab, and says when the switch is refused", async () => {
		// A switch kept the previous organization's members on screen.
		grant(["org.member.read"], { organizations: [org("o1"), org("o2")] });
		bridge.listMembers.mockImplementationOnce(() => ok([member("ana")]));
		bridge.listMembers.mockImplementationOnce(() => ok([member("bo")]));
		bridge.switchOrg.mockImplementationOnce(() => ok(true));
		bridge.myPermissions.mockImplementation(() =>
			ok({
				user_id: "u1",
				platform_role: "user",
				is_platform_admin: false,
				org_id: "o2",
				org_role: "admin",
				permissions: ["org.member.read"],
				organizations: [org("o1"), org("o2")],
			}),
		);
		render(<AdministrationView />);
		expect(await screen.findByText("ana@example.test")).toBeInTheDocument();

		const select = screen.getByLabelText("Current");
		fireEvent.change(select, { target: { value: "o2" } });
		expect(await screen.findByText("bo@example.test")).toBeInTheDocument();
		expect(bridge.switchOrg).toHaveBeenCalledWith("o2");
		expect(screen.queryByText("ana@example.test")).toBeNull();

		bridge.switchOrg.mockImplementationOnce(() => refused("not a member"));
		fireEvent.change(select, { target: { value: "o1" } });
		expect(await screen.findByRole("alert")).toHaveTextContent("not a member");
	});
});

describe("OverviewTab", () => {
	it("says it is loading, then that there is nothing yet", async () => {
		let answer: (value: unknown) => void = () => undefined;
		bridge.overview.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		render(<OverviewTab />);
		expect(screen.getByText("Loading…")).toBeInTheDocument();
		await act(async () => answer({ ok: false, error: "x" }));
		expect(screen.getByText("No activity to report yet.")).toBeInTheDocument();
	});

	it("shows the counts, the runs per day and how close each ceiling is", async () => {
		render(<OverviewTab />);
		expect(await screen.findByText("2 queued")).toBeInTheDocument();
		expect(screen.getByText("of 9 runs")).toBeInTheDocument();
		expect(screen.getByText("of 5 total")).toBeInTheDocument();
		expect(screen.getByText("12 specs")).toBeInTheDocument();
		expect(screen.getByText("88%")).toBeInTheDocument();
		expect(screen.getByRole("img", { name: "Runs over the last 7 days" })).toBeInTheDocument();
		expect(screen.getByTitle("2026-11-16: 4")).toHaveStyle({ height: "100%" });
		expect(screen.getByTitle("2026-11-15: 0")).toHaveStyle({ height: "0%" });
		expect(screen.getByText("11-16")).toBeInTheDocument();

		// No budget: the month's tokens are shown without a limit.
		expect(screen.getByText("Monthly token budget")).toBeInTheDocument();

		// 3 of 10 members, projects without a limit, 2 of 2 runs (at the ceiling).
		expect(screen.getByText("3 / 10")).not.toHaveClass("text-destructive");
		expect(screen.getByText("4 (no limit)")).toBeInTheDocument();
		expect(screen.getByText("2 / 2")).toHaveClass("text-destructive");
		// No failure in 24 h: the card is not in warning, and there are no lists.
		expect(screen.getByText("Failed (24h)").previousElementSibling).toHaveClass("text-muted-foreground");
		expect(screen.queryByText("Most active members")).toBeNull();
		expect(screen.queryByText("Recent failures")).toBeNull();
	});

	it("lists the most active members and the recent failures, warning about them", async () => {
		bridge.overview.mockImplementation(() =>
			ok({
				...OVERVIEW,
				runs_failed_24h: 2,
				runs_by_day: [],
				quota: { ...QUOTA, max_users: 0, used_users: 0 },
				top_users: [{ user_id: "u1", display_name: "Ana", runs: 6 }],
				recent_failures: [
					{ run_id: "r1", phase: "coding", error: "tests failed", finished_at: "2026-11-16T10:00:00Z" },
					{ run_id: "r2", phase: "qa", error: "", finished_at: "2026-11-16T11:00:00Z" },
				],
			}),
		);
		render(<OverviewTab />);
		expect(await screen.findByText("Most active members")).toBeInTheDocument();
		expect(screen.getByText("6 runs")).toBeInTheDocument();
		expect(screen.getByText("tests failed")).toBeInTheDocument();
		expect(screen.getByText("qa").closest("li")?.querySelectorAll("p")).toHaveLength(0);
		expect(screen.getByText("Failed (24h)").previousElementSibling).toHaveClass("text-destructive");
		// A ceiling of 0 is not shown as full.
		expect(screen.getByText("0 / 0")).not.toHaveClass("text-destructive");
	});
});

describe("AuditTab", () => {
	const ENTRIES = [
		{ id: "a1", user_id: "u1", user_email: "ana@example.test", org_id: "o1", project_id: null, action: "role.update", payload: { role: "lead" }, ip: null, created_at: "2026-11-16T10:00:00Z", login_id: "1234567890ab", login_method: "oidc" },
		{ id: "a2", user_id: null, user_email: null, org_id: "o1", project_id: null, action: "org.create", payload: null, ip: null, created_at: "2026-11-16T11:00:00Z" },
		{ id: "a3", user_id: "u2", user_email: "bo@example.test", org_id: "o1", project_id: null, action: "group.create", payload: null, ip: null, created_at: "2026-11-16T12:00:00Z", login_id: "abcdefgh-0000", login_method: null },
	];

	it("filters by action or user, and hides export without the permission", async () => {
		bridge.listAudit.mockImplementation(() => ok(ENTRIES));
		render(<AuditTab />);
		expect(await screen.findByText("role.update")).toBeInTheDocument();
		expect(bridge.listAudit).toHaveBeenCalledWith({ limit: 100 });
		// Who, and under which sign-in: none for the row without one.
		expect(screen.getAllByText("—")).toHaveLength(2);
		expect(screen.getByText("Single sign-on · 12345678")).toHaveAttribute("title", "1234567890ab");
		expect(screen.getByText("Unknown · abcdefgh")).toBeInTheDocument();
		expect(screen.getByText('{"role":"lead"}')).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Export" })).toBeNull();

		const filter = screen.getByPlaceholderText("Filter by action, user or sign-in");
		fireEvent.change(filter, { target: { value: "ana@" } });
		expect(screen.queryByText("org.create")).toBeNull();
		fireEvent.change(filter, { target: { value: "abcdef" } });
		expect(screen.getByText("group.create")).toBeInTheDocument();
		expect(screen.queryByText("role.update")).toBeNull();
		fireEvent.change(filter, { target: { value: "org." } });
		expect(screen.getByText("org.create")).toBeInTheDocument();
		expect(screen.queryByText("role.update")).toBeNull();
		fireEvent.change(filter, { target: { value: "nothing" } });
		expect(screen.getByText("No administrative events recorded yet.")).toBeInTheDocument();
	});

	it("exports the rows shown as a dated JSON file", async () => {
		grant(["audit.export"]);
		bridge.listAudit.mockImplementation(() => ok(ENTRIES));
		const blobs: Blob[] = [];
		const create = vi.fn((blob: Blob) => {
			blobs.push(blob);
			return "blob:audit";
		});
		const revoke = vi.fn();
		Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
		render(<AuditTab />);
		await screen.findByText("role.update");
		fireEvent.change(screen.getByPlaceholderText("Filter by action, user or sign-in"), {
			target: { value: "role" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Export" }));

		expect(click).toHaveBeenCalledOnce();
		const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
		expect(anchor.download).toMatch(/^workpilot-audit-\d{4}-\d{2}-\d{2}\.json$/);
		expect(JSON.parse(await blobs[0].text())).toEqual([ENTRIES[0]]);
		expect(revoke).toHaveBeenCalledWith("blob:audit");
	});
});

describe("MembersTab", () => {
	it("shows members read-only without write rights", async () => {
		bridge.listMembers.mockImplementation(() => ok([member("ana"), member("bo", { is_active: false })]));
		render(<MembersTab />);
		expect(await screen.findByText("ana@example.test")).toBeInTheDocument();
		expect(screen.getAllByText("Lead")).toHaveLength(2);
		expect(screen.getByText("Disabled")).toBeInTheDocument();
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(screen.queryByTitle("Remove from the organization")).toBeNull();
		expect(screen.queryByText("Sessions")).toBeNull();
		expect(bridge.listSessions).not.toHaveBeenCalled();
	});

	it("changes a role, disables or re-enables an account, removes a member and signs one out", async () => {
		grant(["org.member.write", "org.session.read", "org.session.revoke"]);
		bridge.listMembers.mockImplementation(() => ok([member("ana"), member("bo", { is_active: false })]));
		bridge.listSessions.mockImplementation(() =>
			ok([
				{ id: "s1", user_id: "ana", user_agent: null, ip: null, created_at: "", expires_at: "" },
				{ id: "s2", user_id: "ana", user_agent: null, ip: null, created_at: "", expires_at: "" },
			]),
		);
		for (const fn of [bridge.updateMemberRole, bridge.removeMember, bridge.activateUser, bridge.deactivateUser, bridge.revokeSessions]) {
			fn.mockImplementation(() => ok(true));
		}
		render(<MembersTab />);
		const ana = (await screen.findByText("ana@example.test")).closest("tr") as HTMLElement;
		const bo = screen.getByText("bo@example.test").closest("tr") as HTMLElement;
		await waitFor(() => expect(within(ana).getByText("2")).toBeInTheDocument());
		expect(within(bo).getByText("0")).toBeInTheDocument();
		// Nobody to sign out: no button.
		expect(within(bo).queryByTitle("Sign this user out everywhere")).toBeNull();

		await waitFor(() => expect(within(ana).getByRole("combobox")).toHaveTextContent("Admin"));
		fireEvent.change(within(ana).getByRole("combobox", { name: "Role" }), { target: { value: "admin" } });
		await waitFor(() => expect(bridge.updateMemberRole).toHaveBeenCalledWith("ana", "admin"));

		fireEvent.click(within(ana).getByTitle("Disable this account"));
		fireEvent.click(within(bo).getByTitle("Re-enable this account"));
		fireEvent.click(within(bo).getByTitle("Remove from the organization"));
		fireEvent.click(within(ana).getByTitle("Sign this user out everywhere"));
		await waitFor(() => expect(bridge.revokeSessions).toHaveBeenCalledWith("ana"));
		expect(bridge.deactivateUser).toHaveBeenCalledWith("ana");
		expect(bridge.activateUser).toHaveBeenCalledWith("bo");
		expect(bridge.removeMember).toHaveBeenCalledWith("bo");
	});
});

describe("MembersTab, adding an account that already exists", () => {
	it("is offered to a platform administrator only", async () => {
		grant(["org.member.write"]);
		render(<MembersTab />);
		await waitFor(() => expect(bridge.listMembers).toHaveBeenCalled());
		expect(screen.queryByLabelText("Add an account that already exists")).toBeNull();
	});

	it("adds the account by its email with the chosen role, even to an empty organization", async () => {
		grant(["org.member.write"], { isPlatformAdmin: true });
		bridge.addMember.mockImplementation(() => ok(member("cy")));
		render(<MembersTab />);
		const email = await screen.findByLabelText("Add an account that already exists");
		expect(screen.getByText("No members yet.")).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByRole("option", { name: "Lead" })).toBeInTheDocument(),
		);
		fireEvent.change(email, { target: { value: " cy@example.test " } });
		fireEvent.change(screen.getByLabelText("Role"), { target: { value: "lead" } });
		bridge.listMembers.mockImplementation(() => ok([member("cy")]));
		fireEvent.click(screen.getByRole("button", { name: "Add to the organization" }));
		await waitFor(() =>
			expect(bridge.addMember).toHaveBeenCalledWith({ email: "cy@example.test", role_slug: "lead" }),
		);
		expect(await screen.findByText("cy@example.test")).toBeInTheDocument();
		await waitFor(() => expect(email).toHaveValue(""));
	});

	it("keeps the address when the server refuses it", async () => {
		grant(["org.member.write"], { isPlatformAdmin: true });
		bridge.listMembers.mockImplementation(() => ok([member("ana")]));
		bridge.addMember.mockImplementation(() => refused("User not found"));
		render(<MembersTab />);
		const email = await screen.findByLabelText("Add an account that already exists");
		fireEvent.change(email, { target: { value: "who@example.test" } });
		fireEvent.click(screen.getByRole("button", { name: "Add to the organization" }));
		await waitFor(() => expect(useAdminStore.getState().error).toBe("User not found"));
		expect(email).toHaveValue("who@example.test");
	});
});

describe("OrganizationsTab", () => {
	it("tells a non-platform administrator it is not theirs", () => {
		render(<OrganizationsTab />);
		expect(
			screen.getByText("Only a platform administrator can manage organizations."),
		).toBeInTheDocument();
		expect(bridge.listOrgs).not.toHaveBeenCalled();
	});

	it("creates an organization, suspends or reactivates one, and switches to another", async () => {
		grant([], { isPlatformAdmin: true });
		const orgs = [org("o1"), org("o2", { is_active: false })];
		bridge.listOrgs.mockImplementation(() => ok(orgs));
		bridge.createOrg.mockImplementationOnce(() => refused("slug taken"));
		bridge.createOrg.mockImplementationOnce(() => ok(org("o3")));
		bridge.updateOrg.mockImplementation(() => ok(true));
		bridge.switchOrg.mockImplementation(() => refused("no access"));
		render(<OrganizationsTab />);

		const first = (await screen.findByText("Org o1")).closest("tr") as HTMLElement;
		const second = screen.getByText("Org o2").closest("tr") as HTMLElement;
		expect(within(first).getByText("Current")).toBeInTheDocument();
		expect(within(first).queryByText("Switch to")).toBeNull();
		expect(within(second).getByText("Suspended")).toBeInTheDocument();

		const create = screen.getByRole("button", { name: "Create an organization" });
		expect(create).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Beta " } });
		expect(create).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Identifier"), { target: { value: " Beta " } });
		fireEvent.click(create);
		await waitFor(() => expect(bridge.createOrg).toHaveBeenCalledWith({ name: "Beta", slug: "beta" }));
		// A refused creation keeps what was typed.
		expect(screen.getByLabelText("Name")).toHaveValue(" Beta ");
		fireEvent.click(create);
		await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue(""));
		expect(screen.getByLabelText("Identifier")).toHaveValue("");

		fireEvent.click(within(first).getByTitle("Suspend"));
		fireEvent.click(within(second).getByTitle("Reactivate"));
		await waitFor(() => expect(bridge.updateOrg).toHaveBeenCalledWith("o2", { is_active: true }));
		expect(bridge.updateOrg).toHaveBeenCalledWith("o1", { is_active: false });

		fireEvent.click(within(second).getByText("Switch to"));
		await waitFor(() => expect(useAdminStore.getState().error).toBe("no access"));
	});
});

describe("QuotasTab", () => {
	it("shows the ceilings read-only without the permission", async () => {
		render(<QuotasTab />);
		const users = await screen.findByLabelText("Maximum members");
		await waitFor(() => expect(users).toHaveValue(10));
		expect(users).toBeDisabled();
		expect(screen.getByText("3 in use")).toBeInTheDocument();
		expect(screen.getByText("4 in use")).toBeInTheDocument();
		expect(screen.getByLabelText("Maximum projects")).toHaveValue(null);
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
	});

	it("saves typed ceilings, an empty field as no limit", async () => {
		grant(["org.quota.write"]);
		bridge.getQuotas.mockImplementation(() =>
			ok({ ...QUOTA, max_users: null, max_concurrent_runs: null, monthly_token_budget: 5000 }),
		);
		bridge.setQuotas.mockImplementation(() => ok({ ...QUOTA, enforce_hard_stop: true }));
		render(<QuotasTab />);
		await waitFor(() => expect(screen.getByLabelText("Monthly token budget")).toHaveValue(5000));
		fireEvent.change(screen.getByLabelText("Maximum projects"), { target: { value: "8" } });
		fireEvent.change(screen.getByLabelText("Monthly token budget"), { target: { value: "" } });
		fireEvent.click(screen.getByLabelText("Block new runs once the token budget is spent"));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(bridge.setQuotas).toHaveBeenCalledWith({
				enforce_hard_stop: true,
				max_users: null,
				max_projects: 8,
				max_concurrent_runs: null,
				monthly_token_budget: null,
			}),
		);
		// The server's answer becomes what is shown.
		await waitFor(() => expect(screen.getByLabelText("Maximum members")).toHaveValue(10));
	});

	it("shows the tokens this month's runs used against the budget", async () => {
		bridge.getQuotas.mockImplementation(() =>
			ok({ ...QUOTA, monthly_token_budget: 5000, used_tokens_this_month: 1200 }),
		);
		render(<QuotasTab />);
		expect(await screen.findByText("1200 used this month")).toBeInTheDocument();
	});

	it("shows no usage before the quotas are loaded", () => {
		bridge.getQuotas.mockReturnValue(new Promise(() => undefined));
		render(<QuotasTab />);
		expect(screen.queryByText(/in use/)).toBeNull();
	});
});

describe("RolesTab", () => {
	async function renderRoles(permissions: string[] = ["org.role.write"]) {
		grant(permissions);
		render(<RolesTab />);
		await screen.findByText("Lead");
	}

	it("shows a built-in role read-only, with its privileged permissions marked", async () => {
		await renderRoles([]);
		expect(screen.getByText("Select a role to see the permissions it grants.")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "New role" })).toBeNull();
		fireEvent.click(screen.getByText("Admin"));
		expect(screen.getByText(/Built-in roles cannot be edited/)).toBeInTheDocument();
		await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3));
		for (const box of screen.getAllByRole("checkbox")) expect(box).toBeDisabled();
		expect(screen.getByRole("img", { name: "Privileged action" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Delete this role" })).toBeNull();
		expect(screen.getAllByText("1 permissions")).toHaveLength(2);
	});

	it("keeps a custom role read-only without the write permission", async () => {
		await renderRoles([]);
		fireEvent.click(screen.getByText("Lead"));
		await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3));
		expect(screen.getAllByRole("checkbox")[0]).toBeDisabled();
		expect(screen.queryByText(/Built-in roles cannot be edited/)).toBeNull();
	});

	it("grants and withdraws a permission of a custom role, and deletes it", async () => {
		bridge.updateRole.mockImplementation(() => ok(true));
		bridge.deleteRole.mockImplementation(() => ok(true));
		await renderRoles();
		fireEvent.click(screen.getByText("Lead"));
		const [read, run] = await screen.findAllByRole("checkbox");
		expect(read).toBeChecked();
		fireEvent.click(run);
		await waitFor(() =>
			expect(bridge.updateRole).toHaveBeenCalledWith("r-lead", { permissions: ["board.read", "board.run"] }),
		);
		fireEvent.click(read);
		await waitFor(() => expect(bridge.updateRole).toHaveBeenLastCalledWith("r-lead", { permissions: [] }));

		fireEvent.click(screen.getByRole("button", { name: "Delete this role" }));
		await waitFor(() => expect(bridge.deleteRole).toHaveBeenCalledWith("r-lead"));
	});

	it("creates a role from a fresh form each time, named after its slug when unnamed", async () => {
		// Reopening the form kept the slug and name typed before Cancel.
		bridge.createRole.mockImplementationOnce(() => refused("slug taken"));
		bridge.createRole.mockImplementationOnce(() => ok(true));
		await renderRoles();
		fireEvent.click(screen.getByRole("button", { name: "New role" }));
		const create = screen.getByRole("button", { name: "Create" });
		expect(create).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Identifier"), { target: { value: "old" } });
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Old" } });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByLabelText("Identifier")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "New role" }));
		expect(screen.getByLabelText("Identifier")).toHaveValue("");
		expect(screen.getByLabelText("Name")).toHaveValue("");
		fireEvent.change(screen.getByLabelText("Identifier"), { target: { value: " qa " } });
		const [read, run] = screen.getAllByRole("checkbox");
		expect(read).toBeEnabled();
		fireEvent.click(run);
		fireEvent.click(read);
		fireEvent.click(read);
		fireEvent.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() =>
			expect(bridge.createRole).toHaveBeenCalledWith({
				slug: "qa",
				name: "qa",
				permissions: ["board.run"],
			}),
		);
		// Refused: the form stays with what was chosen.
		expect(screen.getAllByRole("checkbox")[1]).toBeChecked();

		fireEvent.change(screen.getByLabelText("Name"), { target: { value: " QA " } });
		fireEvent.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() => expect(screen.queryByLabelText("Identifier")).toBeNull());
		expect(bridge.createRole).toHaveBeenLastCalledWith({
			slug: "qa",
			name: "QA",
			permissions: ["board.run"],
		});
	});

	it("leaves the form when a role is picked", async () => {
		await renderRoles();
		fireEvent.click(screen.getByRole("button", { name: "New role" }));
		fireEvent.click(screen.getByText("Lead"));
		expect(screen.queryByLabelText("Identifier")).toBeNull();
		expect(screen.getByRole("button", { name: "Delete this role" })).toBeInTheDocument();
	});
});
