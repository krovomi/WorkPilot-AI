/**
 * Where the workspace views (dashboard, analytics, costs) read their data: the
 * project folder of this computer, or, for a server project, the server,
 * which computes them from the project's runs (`main/server-workspace.ts`).
 * A server project is asked by its id; its mirror is never read.
 */

import type { CostSummary, DashboardSnapshot, IPCResult } from "@shared/types";
import type { BuildComparison } from "@shared/types/build-compare";

type Answer<T> = { success: boolean; error?: string } & T;

/** The project's dashboard snapshot. */
export async function loadDashboardSnapshot(
	projectPath: string,
	serverProjectId?: string,
): Promise<Answer<{ snapshot?: DashboardSnapshot }>> {
	if (!serverProjectId) {
		return globalThis.electronAPI.getDashboardSnapshot(projectPath);
	}
	const result =
		await globalThis.electronAPI.getServerDashboardSnapshot(serverProjectId);
	return { success: result.success, error: result.error, snapshot: result.data };
}

/** What the project's agents spent over the last thirty days. */
export async function loadCostSummary(
	projectPath: string,
	serverProjectId?: string,
): Promise<Answer<{ summary?: CostSummary }>> {
	if (!serverProjectId) {
		return globalThis.electronAPI.getCostSummary(projectPath);
	}
	const result = await globalThis.electronAPI.getServerCostSummary(serverProjectId);
	return { success: result.success, error: result.error, summary: result.data };
}

/**
 * How the project compares with its past and with other projects: the
 * person's own on this computer, the organization's they may read on a
 * server (medians only).
 */
export function loadBuildComparison(
	projectPath: string,
	serverProjectId?: string,
): Promise<IPCResult<BuildComparison>> {
	return serverProjectId
		? globalThis.electronAPI.getServerBuildComparison(serverProjectId)
		: globalThis.electronAPI.getBuildComparison(projectPath);
}
