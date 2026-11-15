/**
 * The administration console store (server mode): what each action asks the
 * server through the preload bridge, what it keeps of the answer, the list it
 * reloads after a change, and the server's own refusal shown verbatim.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAdminStore } from "../admin-store";

const ok = (data: unknown = null) => ({ ok: true, data });
const refused = (error: string) => ({ ok: false, error });

const METHODS = [
	"overview",
	"permissions",
	"listRoles",
	"listMembers",
	"listOrgs",
	"listSessions",
	"getQuotas",
	"listAudit",
	"listGroups",
	"listGroupProjects",
	"createRole",
	"updateRole",
	"deleteRole",
	"updateMemberRole",
	"removeMember",
	"activateUser",
	"deactivateUser",
	"revokeSessions",
	"createGroup",
	"updateGroup",
	"deleteGroup",
	"setGroupMember",
	"setGroupProjectRole",
	"createOrg",
	"updateOrg",
	"setQuotas",
] as const;

type Bridge = Record<(typeof METHODS)[number], ReturnType<typeof vi.fn>>;
let bridge: Bridge;

const INITIAL = useAdminStore.getState();
const store = () => useAdminStore.getState();

beforeEach(() => {
	useAdminStore.setState(INITIAL, true);
	bridge = Object.fromEntries(
		METHODS.map((m) => [m, vi.fn().mockResolvedValue(ok([]))]),
	) as Bridge;
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = { serverAdmin: bridge };
});

describe("loaders", () => {
	const loaders: Array<[keyof typeof INITIAL, string, keyof typeof INITIAL, unknown]> = [
		["loadOverview", "overview", "overview", { users: 3 }],
		["loadPermissions", "permissions", "permissions", [{ key: "admin.roles" }]],
		["loadRoles", "listRoles", "roles", [{ id: "r1" }]],
		["loadMembers", "listMembers", "members", [{ user_id: "u1" }]],
		["loadOrganizations", "listOrgs", "organizations", [{ id: "o1" }]],
		["loadSessions", "listSessions", "sessions", [{ id: "s1" }]],
		["loadQuotas", "getQuotas", "quotas", { max_users: 5 }],
		["loadGroups", "listGroups", "groups", [{ id: "g1" }]],
		["loadGroupProjects", "listGroupProjects", "groupProjects", [{ id: "p1" }]],
	];

	it.each(loaders)("%s keeps what %s answers", async (action, method, field, data) => {
		bridge[method as keyof Bridge].mockResolvedValue(ok(data));
		await (store()[action] as () => Promise<void>)();
		expect(store()[field]).toEqual(data);
		expect(store().error).toBeNull();
		expect(Object.values(store().loading).every((busy) => busy === false)).toBe(true);
	});

	it("shows the server's refusal verbatim and keeps the last list", async () => {
		useAdminStore.setState({ roles: [{ id: "r1" }] as never });
		bridge.listRoles.mockResolvedValue(refused("Forbidden: admin.roles.read"));
		await store().loadRoles();
		expect(store().error).toBe("Forbidden: admin.roles.read");
		expect(store().roles).toEqual([{ id: "r1" }]);
		store().clearError();
		expect(store().error).toBeNull();
	});

	it("marks a loader busy while it runs", async () => {
		let answer: (v: unknown) => void = () => undefined;
		bridge.listMembers.mockReturnValueOnce(new Promise((r) => (answer = r)));
		const pending = store().loadMembers();
		expect(store().loading.members).toBe(true);
		answer(ok([]));
		await pending;
		expect(store().loading.members).toBe(false);
	});

	it("does not stay busy when the call itself is rejected", async () => {
		bridge.overview.mockRejectedValueOnce(new Error("sender refused"));
		await store().loadOverview();
		expect(store()).toMatchObject({ error: "sender refused", loading: { overview: false } });

		bridge.overview.mockRejectedValueOnce("offline");
		await store().loadOverview();
		expect(store().error).toBe("offline");
	});

	it("asks for the last 100 audit entries unless told otherwise", async () => {
		bridge.listAudit.mockResolvedValue(ok([{ id: "a" }]));
		await store().loadAudit();
		expect(bridge.listAudit).toHaveBeenLastCalledWith({ limit: 100 });
		await store().loadAudit({ action: "role.create", limit: 10 });
		expect(bridge.listAudit).toHaveBeenLastCalledWith({ action: "role.create", limit: 10 });
		expect(store().audit).toEqual([{ id: "a" }]);
	});

	it("says administration is unavailable without the server bridge", async () => {
		(globalThis as unknown as { electronAPI: unknown }).electronAPI = {};
		await store().loadRoles();
		expect(store().error).toBe("Server administration is unavailable in local mode");
		expect(await store().deleteRole("r1")).toBe(false);
	});
});

describe("changes that reload a list", () => {
	const changes: Array<[string, () => Promise<boolean>, string, unknown[], string]> = [
		["createRole", () => store().createRole({ slug: "qa", name: "QA", permissions: ["a"] }), "createRole", [{ slug: "qa", name: "QA", permissions: ["a"] }], "listRoles"],
		["updateRole", () => store().updateRole("r1", { name: "Lead" }), "updateRole", ["r1", { name: "Lead" }], "listRoles"],
		["deleteRole", () => store().deleteRole("r1"), "deleteRole", ["r1"], "listRoles"],
		["setMemberRole", () => store().setMemberRole("u1", "admin"), "updateMemberRole", ["u1", "admin"], "listMembers"],
		["removeMember", () => store().removeMember("u1"), "removeMember", ["u1"], "listMembers"],
		["setUserActive(true)", () => store().setUserActive("u1", true), "activateUser", ["u1"], "listMembers"],
		["setUserActive(false)", () => store().setUserActive("u1", false), "deactivateUser", ["u1"], "listMembers"],
		["revokeSessions", () => store().revokeSessions("u1"), "revokeSessions", ["u1"], "listSessions"],
		["createGroup", () => store().createGroup({ name: "Devs" }), "createGroup", [{ name: "Devs" }], "listGroups"],
		["createOrganization", () => store().createOrganization({ name: "Acme", slug: "acme" }), "createOrg", [{ name: "Acme", slug: "acme" }], "listOrgs"],
		["setOrganizationActive", () => store().setOrganizationActive("o1", false), "updateOrg", ["o1", { is_active: false }], "listOrgs"],
	];

	it.each(changes)("%s sends the change, then reloads", async (_name, run, method, args, reload) => {
		expect(await run()).toBe(true);
		expect(bridge[method as keyof Bridge]).toHaveBeenCalledWith(...args);
		expect(bridge[reload as keyof Bridge]).toHaveBeenCalledOnce();
	});

	it.each(changes)("%s refused reloads nothing and shows why", async (_name, run, method, _args, reload) => {
		bridge[method as keyof Bridge].mockResolvedValue(refused("Role still assigned"));
		expect(await run()).toBe(false);
		expect(bridge[reload as keyof Bridge]).not.toHaveBeenCalled();
		expect(store().error).toBe("Role still assigned");
	});
});

describe("group changes answered with the group", () => {
	const g1 = { id: "g1", name: "Devs" };
	const g2 = { id: "g2", name: "Ops" };
	beforeEach(() => useAdminStore.setState({ groups: [g1, g2] as never }));

	it("puts the server's version of the group in place", async () => {
		bridge.updateGroup.mockResolvedValue(ok({ ...g1, name: "Developers" }));
		expect(await store().updateGroup("g1", { name: "Developers" })).toBe(true);
		expect(bridge.updateGroup).toHaveBeenCalledWith("g1", { name: "Developers" });
		expect(store().groups).toEqual([{ ...g1, name: "Developers" }, g2]);

		bridge.setGroupMember.mockResolvedValue(ok({ ...g2, members: ["u1"] }));
		await store().setGroupMember("g2", "u1", true);
		expect(bridge.setGroupMember).toHaveBeenCalledWith("g2", "u1", true);
		expect(store().groups[1]).toEqual({ ...g2, members: ["u1"] });

		bridge.setGroupProjectRole.mockResolvedValue(ok({ ...g2, projects: [{ id: "p1", role: "write" }] }));
		await store().setGroupProjectRole("g2", "p1", "write" as never);
		expect(bridge.setGroupProjectRole).toHaveBeenCalledWith("g2", "p1", "write");
		expect(store().groups[1]).toMatchObject({ projects: [{ id: "p1" }] });
	});

	it("removes a deleted group, and keeps it when refused", async () => {
		bridge.deleteGroup.mockResolvedValueOnce(refused("Not found"));
		expect(await store().deleteGroup("g1")).toBe(false);
		expect(store().groups).toHaveLength(2);
		bridge.deleteGroup.mockResolvedValueOnce(ok(null));
		expect(await store().deleteGroup("g1")).toBe(true);
		expect(store().groups).toEqual([g2]);
	});
});

it("saveQuotas keeps the quotas the server stored", async () => {
	bridge.setQuotas.mockResolvedValue(ok({ max_users: 10, enforce_hard_stop: true }));
	expect(await store().saveQuotas({ max_users: 10, enforce_hard_stop: true })).toBe(true);
	expect(bridge.setQuotas).toHaveBeenCalledWith({ max_users: 10, enforce_hard_stop: true });
	expect(store().quotas).toEqual({ max_users: 10, enforce_hard_stop: true });
});
