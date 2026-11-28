import { useCallback } from "react";
import { useAdminStore } from "@/stores/admin-store";
import { usePermissionsStore } from "@/stores/permissions-store";

/**
 * Switch the organization being administered, and say so when the server
 * refuses: the console's error banner shows the reason instead of nothing.
 */
export function useSwitchOrg(): (orgId: string) => Promise<void> {
	const switchOrg = usePermissionsStore((s) => s.switchOrg);
	return useCallback(
		async (orgId: string) => {
			const result = await switchOrg(orgId);
			if (!result.ok) useAdminStore.setState({ error: result.error });
		},
		[switchOrg],
	);
}
