/**
 * The signed-in user's effective permissions, for masking the UI.
 *
 * This is presentation only. Hiding a button is not a control: the backend
 * re-checks every permission on every request, and this store exists so a user
 * is not offered an action that would come back 403.
 *
 * In local mode there is no server to ask and no boundary to draw, so the store
 * reports "everything allowed" and every guard in the app becomes inert —
 * exactly the historical single-user behaviour.
 */

import { create } from "zustand";
import type {
	MyPermissions,
	OrganizationSummary,
} from "../../preload/api/modules/server-admin-api";

interface PermissionsState {
	loaded: boolean;
	loading: boolean;
	/** True in local mode: no server, therefore no restrictions. */
	unrestricted: boolean;
	userId: string | null;
	platformRole: string | null;
	isPlatformAdmin: boolean;
	orgId: string | null;
	orgRole: string | null;
	permissions: Set<string>;
	organizations: OrganizationSummary[];
	error: string | null;

	load: () => Promise<void>;
	reset: () => void;
	setUnrestricted: (value: boolean) => void;
	switchOrg: (orgId: string) => Promise<{ ok: boolean; error?: string }>;
	can: (permission: string) => boolean;
	canAny: (...permissions: string[]) => boolean;
}

const EMPTY: Pick<
	PermissionsState,
	| "userId"
	| "platformRole"
	| "isPlatformAdmin"
	| "orgId"
	| "orgRole"
	| "permissions"
	| "organizations"
> = {
	userId: null,
	platformRole: null,
	isPlatformAdmin: false,
	orgId: null,
	orgRole: null,
	permissions: new Set<string>(),
	organizations: [],
};

export const usePermissionsStore = create<PermissionsState>((set, get) => ({
	loaded: false,
	loading: false,
	unrestricted: true,
	error: null,
	...EMPTY,

	setUnrestricted: (value) => set({ unrestricted: value }),

	reset: () =>
		set({ loaded: false, loading: false, error: null, unrestricted: true, ...EMPTY }),

	load: async () => {
		const api = globalThis.electronAPI?.serverAdmin;
		if (!api) {
			// No bridge (local mode, or an older main process): nothing is
			// restricted, and failing open here is correct because there is no
			// server enforcing anything either.
			set({ loaded: true, unrestricted: true, error: null });
			return;
		}

		set({ loading: true, error: null });
		const result = await api.myPermissions();
		if (!result.ok) {
			// Could not ask. Do NOT fall back to "allow everything": in server
			// mode that would show actions the server will refuse, and worse,
			// suggest the user holds rights they do not.
			set({
				loading: false,
				loaded: true,
				unrestricted: false,
				error: result.error,
				...EMPTY,
			});
			return;
		}

		const data: MyPermissions = result.data;
		set({
			loading: false,
			loaded: true,
			unrestricted: false,
			error: null,
			userId: data.user_id,
			platformRole: data.platform_role,
			isPlatformAdmin: data.is_platform_admin,
			orgId: data.org_id,
			orgRole: data.org_role,
			permissions: new Set(data.permissions),
			organizations: data.organizations,
		});
	},

	switchOrg: async (orgId) => {
		const api = globalThis.electronAPI?.serverAdmin;
		if (!api) return { ok: false, error: "Server administration unavailable" };
		const result = await api.switchOrg(orgId);
		if (!result.ok) return { ok: false, error: result.error };
		// Permissions are per-organization, so they must be re-resolved.
		await get().load();
		return { ok: true };
	},

	can: (permission) => {
		const state = get();
		if (state.unrestricted || state.isPlatformAdmin) return true;
		return state.permissions.has(permission);
	},

	canAny: (...permissions) => {
		const state = get();
		if (state.unrestricted || state.isPlatformAdmin) return true;
		return permissions.some((p) => state.permissions.has(p));
	},
}));

/** Whether the current user holds `permission`. Re-renders when it changes. */
export function usePermission(permission: string): boolean {
	return usePermissionsStore((state) =>
		state.unrestricted || state.isPlatformAdmin
			? true
			: state.permissions.has(permission),
	);
}

/** Whether the current user holds at least one of `permissions`. */
export function useAnyPermission(permissions: string[]): boolean {
	return usePermissionsStore((state) => {
		if (state.unrestricted || state.isPlatformAdmin) return true;
		return permissions.some((p) => state.permissions.has(p));
	});
}

/** Non-reactive read, for event handlers and one-off checks. */
export function hasPermission(permission: string): boolean {
	return usePermissionsStore.getState().can(permission);
}
