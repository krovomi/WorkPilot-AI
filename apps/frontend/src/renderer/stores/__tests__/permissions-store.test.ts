/**
 * The permission store decides what the UI offers.
 *
 * The case worth pinning is the failure one: when the server cannot be asked,
 * the store must NOT fall back to "allow everything". Doing so in server mode
 * would show actions the server refuses and, worse, suggest the user holds
 * rights they do not. Local mode is the opposite: there is no server enforcing
 * anything, so unrestricted is correct there.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasPermission, usePermissionsStore } from "../permissions-store";

const INITIAL = {
	loaded: false,
	loading: false,
	unrestricted: true,
	userId: null,
	platformRole: null,
	isPlatformAdmin: false,
	orgId: null,
	orgRole: null,
	permissions: new Set<string>(),
	organizations: [],
	error: null,
};

function setBridge(serverAdmin: unknown): void {
	(globalThis as { electronAPI?: unknown }).electronAPI = { serverAdmin };
}

describe("permissions store", () => {
	beforeEach(() => {
		usePermissionsStore.setState({ ...INITIAL });
		(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
	});

	describe("local mode", () => {
		it("allows everything when there is no server bridge", async () => {
			await usePermissionsStore.getState().load();
			const state = usePermissionsStore.getState();
			expect(state.loaded).toBe(true);
			expect(state.unrestricted).toBe(true);
			expect(state.can("task.merge")).toBe(true);
			expect(state.can("anything.at.all")).toBe(true);
		});
	});

	describe("server mode", () => {
		it("stores the permissions the server reports", async () => {
			setBridge({
				myPermissions: vi.fn().mockResolvedValue({
					ok: true,
					data: {
						user_id: "u1",
						platform_role: "member",
						is_platform_admin: false,
						org_id: "org1",
						org_role: "contributor",
						permissions: ["task.read", "task.write"],
						organizations: [],
					},
				}),
			});

			await usePermissionsStore.getState().load();
			const state = usePermissionsStore.getState();

			expect(state.unrestricted).toBe(false);
			expect(state.orgRole).toBe("contributor");
			expect(state.can("task.write")).toBe(true);
			expect(state.can("task.merge")).toBe(false);
		});

		it("does not fall back to allow-all when the server cannot be reached", async () => {
			setBridge({
				myPermissions: vi.fn().mockResolvedValue({
					ok: false,
					error: "Network unreachable",
				}),
			});

			await usePermissionsStore.getState().load();
			const state = usePermissionsStore.getState();

			expect(state.loaded).toBe(true);
			expect(state.unrestricted).toBe(false);
			expect(state.error).toBe("Network unreachable");
			expect(state.can("task.read")).toBe(false);
		});

		it("gives a platform admin every permission without listing them", async () => {
			setBridge({
				myPermissions: vi.fn().mockResolvedValue({
					ok: true,
					data: {
						user_id: "ops",
						platform_role: "admin",
						is_platform_admin: true,
						org_id: "org1",
						org_role: "platform-admin",
						permissions: [],
						organizations: [],
					},
				}),
			});

			await usePermissionsStore.getState().load();
			expect(usePermissionsStore.getState().can("platform.org.write")).toBe(true);
		});

		it("re-resolves permissions after switching organization", async () => {
			const myPermissions = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					data: {
						user_id: "u1",
						platform_role: "member",
						is_platform_admin: false,
						org_id: "org1",
						org_role: "admin",
						permissions: ["task.merge"],
						organizations: [],
					},
				})
				.mockResolvedValueOnce({
					ok: true,
					data: {
						user_id: "u1",
						platform_role: "member",
						is_platform_admin: false,
						org_id: "org2",
						org_role: "viewer",
						permissions: ["task.read"],
						organizations: [],
					},
				});
			setBridge({
				myPermissions,
				switchOrg: vi.fn().mockResolvedValue({ ok: true, data: true }),
			});

			await usePermissionsStore.getState().load();
			expect(usePermissionsStore.getState().can("task.merge")).toBe(true);

			await usePermissionsStore.getState().switchOrg("org2");
			const state = usePermissionsStore.getState();
			expect(state.orgId).toBe("org2");
			expect(state.can("task.merge")).toBe(false);
			expect(state.can("task.read")).toBe(true);
		});
	});

	describe("reset", () => {
		it("drops a previous user's rights on sign-out", async () => {
			usePermissionsStore.setState({
				loaded: true,
				unrestricted: false,
				permissions: new Set(["task.merge"]),
			});
			expect(hasPermission("task.merge")).toBe(true);

			usePermissionsStore.getState().reset();
			const state = usePermissionsStore.getState();
			expect(state.loaded).toBe(false);
			expect(state.permissions.size).toBe(0);
		});
	});

	describe("canAny", () => {
		it("is true when at least one permission is held", async () => {
			usePermissionsStore.setState({
				unrestricted: false,
				permissions: new Set(["audit.read"]),
			});
			const state = usePermissionsStore.getState();
			expect(state.canAny("org.role.read", "audit.read")).toBe(true);
			expect(state.canAny("org.role.read", "org.quota.read")).toBe(false);
		});
	});
});
