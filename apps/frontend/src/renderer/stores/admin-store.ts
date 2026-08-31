/**
 * State for the administration console.
 *
 * Every action forwards to the server through the preload bridge and stores
 * whatever comes back — including the errors, which are the server's own
 * explanations (a quota reached, a built-in role being read-only, a role still
 * assigned to members) and are worth showing verbatim.
 */

import { create } from "zustand";
import type {
	AdminOverview,
	AuditEntry,
	OrganizationSummary,
	OrgMemberSummary,
	PermissionDescriptor,
	QuotaSummary,
	RoleSummary,
	SessionSummary,
} from "../../preload/api/modules/server-admin-api";

type Api = NonNullable<typeof globalThis.electronAPI>["serverAdmin"];

interface AdminState {
	overview: AdminOverview | null;
	permissions: PermissionDescriptor[];
	roles: RoleSummary[];
	members: OrgMemberSummary[];
	organizations: OrganizationSummary[];
	sessions: SessionSummary[];
	quotas: QuotaSummary | null;
	audit: AuditEntry[];

	loading: Record<string, boolean>;
	error: string | null;

	clearError: () => void;
	loadOverview: () => Promise<void>;
	loadPermissions: () => Promise<void>;
	loadRoles: () => Promise<void>;
	loadMembers: () => Promise<void>;
	loadOrganizations: () => Promise<void>;
	loadSessions: () => Promise<void>;
	loadQuotas: () => Promise<void>;
	loadAudit: (params?: { action?: string; limit?: number }) => Promise<void>;

	createRole: (body: {
		slug: string;
		name: string;
		description?: string;
		permissions: string[];
	}) => Promise<boolean>;
	updateRole: (
		roleId: string,
		body: { name?: string; description?: string; permissions?: string[] },
	) => Promise<boolean>;
	deleteRole: (roleId: string) => Promise<boolean>;

	setMemberRole: (userId: string, roleSlug: string) => Promise<boolean>;
	removeMember: (userId: string) => Promise<boolean>;
	setUserActive: (userId: string, active: boolean) => Promise<boolean>;
	revokeSessions: (userId: string) => Promise<boolean>;

	createOrganization: (body: { name: string; slug: string }) => Promise<boolean>;
	setOrganizationActive: (orgId: string, active: boolean) => Promise<boolean>;

	saveQuotas: (body: {
		max_users?: number | null;
		max_projects?: number | null;
		max_concurrent_runs?: number | null;
		monthly_token_budget?: number | null;
		enforce_hard_stop?: boolean;
	}) => Promise<boolean>;
}

function api(): Api | null {
	return globalThis.electronAPI?.serverAdmin ?? null;
}

export const useAdminStore = create<AdminState>((set, get) => {
	/** Run a loader under a named busy flag, storing the error if it fails. */
	async function withLoading<T>(
		key: string,
		run: (a: Api) => Promise<{ ok: true; data: T } | { ok: false; error: string }>,
		onSuccess: (data: T) => void,
	): Promise<boolean> {
		const bridge = api();
		if (!bridge) {
			set({ error: "Server administration is unavailable in local mode" });
			return false;
		}
		set((s) => ({ loading: { ...s.loading, [key]: true }, error: null }));
		const result = await run(bridge);
		set((s) => ({ loading: { ...s.loading, [key]: false } }));
		if (!result.ok) {
			set({ error: result.error });
			return false;
		}
		onSuccess(result.data);
		return true;
	}

	return {
		overview: null,
		permissions: [],
		roles: [],
		members: [],
		organizations: [],
		sessions: [],
		quotas: null,
		audit: [],
		loading: {},
		error: null,

		clearError: () => set({ error: null }),

		loadOverview: async () => {
			await withLoading("overview", (a) => a.overview(), (d) => set({ overview: d }));
		},
		loadPermissions: async () => {
			await withLoading(
				"permissions",
				(a) => a.permissions(),
				(d) => set({ permissions: d }),
			);
		},
		loadRoles: async () => {
			await withLoading("roles", (a) => a.listRoles(), (d) => set({ roles: d }));
		},
		loadMembers: async () => {
			await withLoading(
				"members",
				(a) => a.listMembers(),
				(d) => set({ members: d }),
			);
		},
		loadOrganizations: async () => {
			await withLoading(
				"organizations",
				(a) => a.listOrgs(),
				(d) => set({ organizations: d }),
			);
		},
		loadSessions: async () => {
			await withLoading(
				"sessions",
				(a) => a.listSessions(),
				(d) => set({ sessions: d }),
			);
		},
		loadQuotas: async () => {
			await withLoading("quotas", (a) => a.getQuotas(), (d) => set({ quotas: d }));
		},
		loadAudit: async (params) => {
			await withLoading(
				"audit",
				(a) => a.listAudit({ limit: 100, ...params }),
				(d) => set({ audit: d }),
			);
		},

		createRole: async (body) => {
			const ok = await withLoading(
				"createRole",
				(a) => a.createRole(body),
				() => undefined,
			);
			if (ok) await get().loadRoles();
			return ok;
		},
		updateRole: async (roleId, body) => {
			const ok = await withLoading(
				"updateRole",
				(a) => a.updateRole(roleId, body),
				() => undefined,
			);
			if (ok) await get().loadRoles();
			return ok;
		},
		deleteRole: async (roleId) => {
			const ok = await withLoading(
				"deleteRole",
				(a) => a.deleteRole(roleId),
				() => undefined,
			);
			if (ok) await get().loadRoles();
			return ok;
		},

		setMemberRole: async (userId, roleSlug) => {
			const ok = await withLoading(
				"setMemberRole",
				(a) => a.updateMemberRole(userId, roleSlug),
				() => undefined,
			);
			if (ok) await get().loadMembers();
			return ok;
		},
		removeMember: async (userId) => {
			const ok = await withLoading(
				"removeMember",
				(a) => a.removeMember(userId),
				() => undefined,
			);
			if (ok) await get().loadMembers();
			return ok;
		},
		setUserActive: async (userId, active) => {
			const ok = await withLoading(
				"setUserActive",
				(a) => (active ? a.activateUser(userId) : a.deactivateUser(userId)),
				() => undefined,
			);
			if (ok) await get().loadMembers();
			return ok;
		},
		revokeSessions: async (userId) => {
			const ok = await withLoading(
				"revokeSessions",
				(a) => a.revokeSessions(userId),
				() => undefined,
			);
			if (ok) await get().loadSessions();
			return ok;
		},

		createOrganization: async (body) => {
			const ok = await withLoading(
				"createOrganization",
				(a) => a.createOrg(body),
				() => undefined,
			);
			if (ok) await get().loadOrganizations();
			return ok;
		},
		setOrganizationActive: async (orgId, active) => {
			const ok = await withLoading(
				"setOrganizationActive",
				(a) => a.updateOrg(orgId, { is_active: active }),
				() => undefined,
			);
			if (ok) await get().loadOrganizations();
			return ok;
		},

		saveQuotas: async (body) => {
			return withLoading("saveQuotas", (a) => a.setQuotas(body), (d) =>
				set({ quotas: d }),
			);
		},
	};
});
